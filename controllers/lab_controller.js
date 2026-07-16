// server/controllers/lab_controller.js
const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')
const { createNotification, NOTIFICATION_TYPES } = require('../utils/helpers')


// Urgency sort order: stat → urgent → routine
const URGENCY_ORDER = { stat: 0, urgent: 1, routine: 2 }
function shapeRequest(r) {
  return {
    id: r.id,
    visit_id: r.visit_id,
    urgency: r.urgency,
    ordered_by: r.ordered_by ?? null,
    ordered_at: r.requested_at,
    completed_at: r.completed_at ?? null,
    status: r.status,
    notes: r.notes ?? null,
    tech_id: r.tech_id ?? null,
    tech_name: r.tech?.username ?? null,
    // Patient info joined from visit → patient
    patient_name: r.visit?.patient?.name ?? null,
    patient_age: r.visit?.patient?.age ?? null,
    patient_gender: r.visit?.patient?.gender ?? null,
    blood_group: r.visit?.patient?.blood_group ?? null,
    allergies: r.visit?.patient?.allergies ?? null,
    items: (r.items ?? []).map((it) => ({
      id: it.id,
      test_name: it.test_name,
      category: it.category ?? null,
      reference_range: it.reference_range ?? null,
      unit_cost: it.unit_cost,
      result: it.result ?? null,
      // ADDED: structured result fields from the schema
      result_data: it.result_data ?? null,
      result_notes: it.result_notes ?? null,
      flagged: it.flagged ?? false,
      status: it.status,
      completed_at: it.completed_at ?? null,
      // ADDED: the catalog entry drives ResultsModal's input fields
      catalog: it.catalog
        ? {
          id: it.catalog.id,
          name: it.catalog.name,
          category: it.catalog.category,
          reference_range: it.catalog.reference_range,
          result_template: it.catalog.result_template,
        }
        : null,
    })),
  }
}


const REQUEST_INCLUDE = {
  visit: {
    select: {
      id: true,
      queue_number: true,
      visit_type: true,
      referred_by: true,
      referrer_phone: true,
      arrived_at: true,
      patient: {
        select: {
          id: true,
          name: true,
          age: true,
          gender: true,
          phone: true,
          blood_group: true,
          allergies: true,
        },
      }
    },
  },
  // catalog lives on LabRequestItem, not LabRequest
  items: {
    include: {
      catalog: {
        select: {
          id: true,
          name: true,
          category: true,
          result_template: true,
          reference_range: true,
        },
      },
    },
  },
  tech: {
    select: { id: true, username: true },
  },
}

// ─── Stats ────────────────────────────────────────────────────────────────────

exports.getStats = async (req, res) => {
  try {
    const [pending, in_progress, ready, total] = await Promise.all([
      prisma.labRequest.count({ where: { status: 'pending' } }),
      prisma.labRequest.count({ where: { status: 'in_progress' } }),
      prisma.labRequest.count({
        where: {
          status: 'ready',
          completed_at: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      prisma.labRequest.count(),
    ])

    res.json({ stats: { pending, in_progress, ready, total } })
  } catch (err) {
    console.error('getStats', err)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
}

// ─── Queue ────────────────────────────────────────────────────────────────────


exports.getQueue = async (req, res) => {
  try {
    const requests = await prisma.labRequest.findMany({
      where: { status: { in: ['pending', 'in_progress'] } },
      include: REQUEST_INCLUDE,
      orderBy: { requested_at: 'asc' },
    })

    // Sort: stat → urgent → routine, then by arrival time within each group
    const sorted = requests
      .map(shapeRequest)
      .sort((a, b) => {
        const uDiff = (URGENCY_ORDER[a.urgency] ?? 2) - (URGENCY_ORDER[b.urgency] ?? 2)
        if (uDiff !== 0) return uDiff
        return new Date(a.ordered_at) - new Date(b.ordered_at)
      })

    res.json({ requests: sorted })
  } catch (err) {
    console.error('getQueue', err)
    res.status(500).json({ error: 'Failed to fetch queue' })
  }
}

// ─── All requests (RequestsTab) ───────────────────────────────────────────────

exports.getRequests = async (req, res) => {
  try {
    const { status } = req.query
    const where = status && status !== 'all' ? { status } : {}

    const requests = await prisma.labRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: { requested_at: 'desc' },
    })

    res.json({ requests: requests.map(shapeRequest) })
  } catch (err) {
    console.error('getRequests', err)
    res.status(500).json({ error: 'Failed to fetch requests' })
  }
}

// ─── Single request (for direct report links / notifications) ────────────────

exports.getRequestById = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const request = await prisma.labRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    })
    if (!request) return res.status(404).json({ error: 'Lab request not found' })
    res.json({ request: shapeRequest(request) })
  } catch (err) {
    console.error('getRequestById', err)
    res.status(500).json({ error: 'Failed to fetch request' })
  }
}

// ─── Update request status ────────────────────────────────────────────────────

exports.updateRequestStatus = async (req, res) => {
  try {
    const requestId = parseInt(req.params.id)
    const currentUser = req.user
    const { status, item_results = [] } = req.body
    const io = getIO()

    // 1. Set top-level request status + assign tech
    await prisma.labRequest.update({
      where: { id: requestId },
      data: {
        status,
        tech_id: currentUser?.id,
      },
    })

    // 2. Write per-item results
    if (item_results.length > 0) {
      await Promise.all(
        item_results.map((it) => {
          const itemReady = status === 'ready' && !!it.result
          return prisma.labRequestItem.update({
            where: { id: parseInt(it.id) },
            data: {
              result: it.result ?? null,
              result_data: it.result_data ?? null,
              result_notes: it.result_notes ?? null,
              flagged: !!it.flagged,
              status: itemReady ? 'ready' : 'in_progress',
              completed_at: itemReady ? new Date() : null,
            },
          })
        })
      )
    }

    // 3. Auto-promote request to 'ready' if all items are now ready
    const allItems = await prisma.labRequestItem.findMany({
      where: { lab_request_id: requestId },
      select: { status: true },
    })
    const allItemsReady = allItems.length > 0 && allItems.every((i) => i.status === 'ready')
    const finalStatus = allItemsReady ? 'ready' : status

    if (finalStatus === 'ready') {
      await prisma.labRequest.update({
        where: { id: requestId },
        data: { status: 'ready', completed_at: new Date() },
      })
    }

    // 4. Fetch visit context for cascade + socket emits
    const request = await prisma.labRequest.findUnique({
      where: { id: requestId },
      select: {
        visit_id: true,
        visit: {
          select: {
            doctor_id: true,
            visit_type: true,
            patient: { select: { name: true } },
          },
        },
      },
    })

    const patientName = request?.visit?.patient?.name ?? 'patient'

    // 5. If ALL requests for this visit are ready → notify doctor + flip visit status
    if (request && finalStatus === 'ready') {
      const allVisitRequests = await prisma.labRequest.findMany({
        where: { visit_id: request.visit_id },
        select: { status: true },
      })
      const allVisitReady = allVisitRequests.every((r) => r.status === 'ready')

      if (allVisitReady) {
        await prisma.visit.update({
          where: { id: request.visit_id },
          data: { has_lab_results: true, status: request.visit.visit_type === 'direct_lab' ? 'billing' : 'with_doctor' },
        })



        try {
          if (request.visit.visit_type === 'direct_lab') {
            // Create a notification for the reception for billing
            await createNotification({
              type: NOTIFICATION_TYPES.LAB_RESULTS_READY,
              title: 'Lab results ready for billing',
              message: `Results for ${patientName} are ready for billing.`,
              targetRoles: ['receptionist'],
              visitId: request.visit_id,
              io
            })
          } else {
            await createNotification({
              type: NOTIFICATION_TYPES.LAB_RESULTS_READY,
              title: 'Lab results ready for review',
              message: `Results for ${patientName} are ready for review.`,
              targetRoles: ['doctor'],
              visitId: request.visit_id,
              io
            })
            io.to('doctor').emit('lab:results_ready', { visitId: request.visit_id, patientName })
          }
        } catch (socketErr) {
          console.error('Socket emit failed:', socketErr.message)
        }
      }
    }

    // Emit status change for draft saves too so the queue updates live
    if (status === 'in_progress' && item_results.length === 0) {
      try {
        getIO().emit('visit:status_changed', { visitId: request?.visit_id })
      } catch (socketErr) {
        console.error('Socket emit failed:', socketErr)
      }
    }

    res.status(200).json({ success: true })
  } catch (err) {
    console.error('updateRequestStatus', err.message)
    res.status(500).json({ error: 'Failed to update request' })
  }
}

// ─── Test Catalog ──────────────────────────────────────────────────────────────

exports.getLabTestCatalog = async (req, res) => {
  try {
    const { search, category } = req.query
    const where = { is_active: true }
    if (category && category !== 'all') where.category = category
    if (search?.trim()) {
      where.name = { contains: search.trim(), mode: 'insensitive' }
    }

    const tests = await prisma.labTestCatalog.findMany({
      where,
      select: { id: true, name: true, category: true, reference_range: true, unit_cost: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })

    res.json({ tests })
  } catch (err) {
    console.error('getLabTestCatalog', err)
    res.status(500).json({ error: 'Failed to fetch lab test catalog' })
  }
}

// ─── Stock ────────────────────────────────────────────────────────────────────

exports.getStock = async (req, res) => {
  try {
    const items = await prisma.labStock.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
    res.json({ items })
  } catch (err) {
    console.error('getStock', err)
    res.status(500).json({ error: 'Failed to fetch stock' })
  }
}

// ─── Pharmacy supply orders (PharmacyOrdersTab) ───────────────────────────────

exports.getLabOrders = async (req, res) => {
  try {
    const orders = await prisma.pharmacyOrder.findMany({
      where: { department: 'lab' },
      include: { items: true },
      orderBy: { requested_at: 'desc' },
    })
    res.json({ orders })
  } catch (err) {
    console.error('getLabOrders', err)
    res.status(500).json({ error: 'Failed to fetch orders' })
  }
}