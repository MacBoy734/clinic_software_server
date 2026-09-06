// server/controllers/lab_controller.js
const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')
const pharmacy = require('./pharmacy_controller')
const { createNotification, NOTIFICATION_TYPES, writeAuditLog } = require('../utils/helpers')

const MEDICATION = pharmacy.MEDICATION


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
    age_unit: r.visit?.patient?.age_unit ?? 'years',
    patient_gender: r.visit?.patient?.gender ?? null,
    blood_group: r.visit?.patient?.blood_group ?? null,
    items: (r.items ?? []).map((it) => ({
      id: it.id,
      test_name: it.test_name,
      category: it.category ?? null,
      reference_range: it.reference_range ?? null,
      unit_cost: it.unit_cost,
      result: it.result ?? null,
      result_data: it.result_data ?? null,
      applied_ranges: it.applied_ranges ?? null,
      result_notes: it.result_notes ?? null,
      flagged: it.flagged ?? false,
      status: it.status,
      completed_at: it.completed_at ?? null,
      stock_used: (it.stock_usages ?? []).map((u) => ({
        id: u.id,
        stock_item_id: u.stock_item_id,
        item_name: u.item_name,
        quantity: u.quantity,
        quantity_deducted: u.quantity_deducted,
      })),
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
          age_unit: true,
          gender: true,
          phone: true,
          blood_group: true,
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
      // ADDED: persisted consumable usage rows
      stock_usages: true,
    },
  },
  tech: {
    select: { id: true, username: true },
  },
}

const RESTOCK_INCLUDE = {
  lab_stock: {
    select: { id: true, name: true, current_stock: true, category: true },
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
      orderBy: { requested_at: 'desc' },
    })

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

// ORDERS
exports.createPharmacyOrder = pharmacy.createInternalOrder

exports.getLabOrders = async (req, res) => {
  try {
    const orders = await prisma.pharmacyOrder.findMany({
      where: { department: 'lab' },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true, category: true, sub_category: true,
                unit: true, current_stock: true,
              },
            },
          },
        },
      },
      orderBy: { requested_at: 'desc' },
      take: 200,
    })

    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        department: o.department,
        requested_by: o.requested_by,
        status: o.status,
        requested_at: o.requested_at,
        fulfilled_by: o.fulfilled_by ?? null,
        fulfilled_at: o.fulfilled_at ?? null,
        cancelled_by: o.cancelled_by ?? null,
        cancelled_at: o.cancelled_at ?? null,
        cancel_reason: o.cancel_reason ?? null,
        notes: o.notes ?? null,
        items: o.items.map((it) => ({
          id: it.id,
          name: it.name,
          quantity: it.quantity,
          fulfilled_qty: it.fulfilled_qty,
          notes: it.notes ?? null,
          product_id: it.product_id ?? null,
          category: it.product?.category ?? null,
          sub_category: it.product?.sub_category ?? null,
          unit: it.product?.unit ?? null,
        })),
      })),
    })
  } catch (err) {
    console.error('getLabOrders', err.message)
    res.status(500).json({ error: 'Failed to fetch orders' })
  }
}

exports.getSupplies = async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    const items = await prisma.product.findMany({
      where: {
        category: { not: MEDICATION },
        is_active: true,
        ...(q
          ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { sub_category: { contains: q, mode: 'insensitive' } },
              { sku: { contains: q, mode: 'insensitive' } },
            ],
          }
          : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: 300,
    })

    res.json({
      items: items.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        sub_category: p.sub_category ?? null,
        unit: p.unit,
        current_stock: p.current_stock,
        reorder_level: p.reorder_level,
      })),
      categories: [...new Set(items.map((p) => p.category))].sort(),
      sub_categories: [...new Set(items.map((p) => p.sub_category).filter(Boolean))].sort(),
    })
  } catch (err) {
    console.error('getSupplies', err.message)
    res.status(500).json({ error: 'Failed to fetch supplies' })
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
    res.status(200).json({ requests: requests.map(shapeRequest) })
  } catch (err) {
    console.error('getRequests', err.message)
    res.status(500).json({ error: 'Failed to fetch requests' })
  }
}


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

async function reconcileStockUsage(tx, labRequestItemId, testName, incomingRows, techId, warnings) {
  // Merge duplicate incoming rows for the same stock item (the UI allows
  // adding two rows with the same item; the unique constraint does not).
  const merged = new Map()
  for (const row of incomingRows) {
    const stockId = parseInt(row.stock_item_id)
    const qty = parseInt(row.quantity)
    if (!Number.isInteger(stockId) || stockId <= 0) continue
    if (!Number.isInteger(qty) || qty <= 0) {
      warnings.push(`${testName}: skipped "${row.item_name || 'stock item'}" — invalid quantity`)
      continue
    }
    merged.set(stockId, (merged.get(stockId) || 0) + qty)
  }

  const existing = await tx.labStockUsage.findMany({
    where: { lab_request_item_id: labRequestItemId, stock_item_id: { not: null } },
  })
  const existingByStock = new Map(existing.map((u) => [u.stock_item_id, u]))

  // Create / update pass
  for (const [stockId, qty] of merged) {
    const stock = await tx.labStock.findUnique({ where: { id: stockId } })
    const prior = existingByStock.get(stockId)
    existingByStock.delete(stockId) // whatever happens, it is not "removed"

    if (!stock) {
      warnings.push(`${testName}: stock item #${stockId} no longer exists — usage not recorded`)
      continue
    }

    const priorDeducted = prior?.quantity_deducted ?? 0
    let deducted = priorDeducted

    if (priorDeducted < qty) {
      // Need more than previously taken — deduct the difference, floor at 0
      const need = qty - priorDeducted
      const take = Math.min(need, Math.max(stock.current_stock, 0))
      if (take > 0) {
        await tx.labStock.update({
          where: { id: stockId },
          data: { current_stock: { decrement: take } },
        })
      }
      deducted = priorDeducted + take
      if (deducted < qty) {
        warnings.push(
          `${testName}: "${stock.name}" recorded ${qty} ${stock.unit} but stock only covered ${deducted} — short by ${qty - deducted}. Reconcile shelf count.`
        )
      }
    } else if (priorDeducted > qty) {
      // Tech reduced the quantity — return the difference to stock
      await tx.labStock.update({
        where: { id: stockId },
        data: { current_stock: { increment: priorDeducted - qty } },
      })
      deducted = qty
    }

    if (prior) {
      await tx.labStockUsage.update({
        where: { id: prior.id },
        data: {
          quantity: qty,
          quantity_deducted: deducted,
          item_name: stock.name,
          recorded_by: techId ?? prior.recorded_by,
        },
      })
    } else {
      await tx.labStockUsage.create({
        data: {
          lab_request_item_id: labRequestItemId,
          stock_item_id: stockId,
          item_name: stock.name,
          quantity: qty,
          quantity_deducted: deducted,
          unit: stock.unit,
          unit_cost: stock.unit_cost,
          recorded_by: techId ?? null,
        },
      })
    }
  }

  // Removal pass — anything persisted but absent from the payload was
  // deleted by the tech in the modal: restore what was actually taken.
  for (const u of existingByStock.values()) {
    if (u.quantity_deducted > 0) {
      await tx.labStock.update({
        where: { id: u.stock_item_id },
        data: { current_stock: { increment: u.quantity_deducted } },
      })
    }
    await tx.labStockUsage.delete({ where: { id: u.id } })
  }
}

// ─── Update request status ────────────────────────────────────────────────────

exports.updateRequestStatus = async (req, res) => {
  try {
    const requestId = parseInt(req.params.id)
    const currentUser = req.user
    const { status, item_results = [] } = req.body

    if (!Number.isInteger(requestId)) {
      return res.status(400).json({ error: 'Invalid request id' })
    }
    if (!['in_progress', 'ready'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    const warnings = []

    // All data writes — request status, item results, stock movement, the
    // ready-promotion, and the visit flip — happen in ONE transaction so a
    // partial failure can never deduct stock without saving results (or the
    // reverse). Notifications and socket emits stay OUTSIDE the transaction:
    // a notification failure must not roll back clinical data.
    const outcome = await prisma.$transaction(async (tx) => {
      const reqRow = await tx.labRequest.findUnique({
        where: { id: requestId },
        select: { id: true, items: { select: { id: true, test_name: true } } },
      })
      if (!reqRow) return { notFound: true }

      const itemNameById = new Map(reqRow.items.map((i) => [i.id, i.test_name]))

      // 1. Set top-level request status + assign tech
      await tx.labRequest.update({
        where: { id: requestId },
        data: {
          status,
          tech_id: currentUser?.id,
        },
      })

      // 2. Write per-item results + reconcile consumable usage
      for (const it of item_results) {
        const itemId = parseInt(it.id)
        // Ownership guard — only items belonging to this request are writable
        if (!itemNameById.has(itemId)) {
          warnings.push(`Skipped unknown test item #${it.id} — not part of this request`)
          continue
        }

        const itemReady = status === 'ready' && !!it.result
        await tx.labRequestItem.update({
          where: { id: itemId },
          data: {
            result: it.result ?? null,
            result_data: it.result_data ?? null,
            applied_ranges: it.applied_ranges ?? undefined,
            result_notes: it.result_notes ?? null,
            flagged: !!it.flagged,
            status: itemReady ? 'ready' : 'in_progress',
            completed_at: itemReady ? new Date() : null,
          },
        })

        // Contract: the modal ALWAYS sends stock_used (possibly []) for every
        // item — [] means "the tech cleared them" and restores stock. A payload
        // with the key MISSING entirely (e.g. the Start button's bare status
        // call) means "no opinion" and touches nothing.
        if (Array.isArray(it.stock_used)) {
          await reconcileStockUsage(
            tx,
            itemId,
            itemNameById.get(itemId),
            it.stock_used,
            currentUser?.id,
            warnings
          )
        }
      }

      // 3. Auto-promote request to 'ready' if all items are now ready
      const allItems = await tx.labRequestItem.findMany({
        where: { lab_request_id: requestId },
        select: { status: true },
      })
      const allItemsReady = allItems.length > 0 && allItems.every((i) => i.status === 'ready')
      const finalStatus = allItemsReady ? 'ready' : status

      if (finalStatus === 'ready') {
        await tx.labRequest.update({
          where: { id: requestId },
          data: { status: 'ready', completed_at: new Date() },
        })
      }

      // 4. Fetch visit context for cascade + socket emits
      const request = await tx.labRequest.findUnique({
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

      // 5. If ALL requests for this visit are ready → flip visit status
      let allVisitReady = false
      if (request && finalStatus === 'ready') {
        const allVisitRequests = await tx.labRequest.findMany({
          where: { visit_id: request.visit_id },
          select: { status: true },
        })
        allVisitReady = allVisitRequests.every((r) => r.status === 'ready')

        if (allVisitReady) {
          await tx.visit.update({
            where: { id: request.visit_id },
            data: {
              has_lab_results: true,
              status: request.visit.visit_type === 'direct_lab' ? 'billing' : 'with_doctor',
            },
          })
        }
      }

      return { finalStatus, request, allVisitReady }
    })

    if (outcome.notFound) {
      return res.status(404).json({ error: 'Lab request not found' })
    }

    const { finalStatus, request, allVisitReady } = outcome
    const patientName = request?.visit?.patient?.name ?? 'patient'
    const io = getIO()

    // Notifications + sockets — outside the transaction
    if (request && finalStatus === 'ready' && allVisitReady) {
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

    // Emit status change for draft saves too so the queue updates live
    if (status === 'in_progress' && item_results.length === 0) {
      try {
        io.emit('visit:status_changed', { visitId: request?.visit_id })
      } catch (socketErr) {
        console.error('Socket emit failed:', socketErr)
      }
    }

    res.status(200).json({ success: true, warnings })
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
      select: { id: true, name: true, category: true, reference_range: true, unit_cost: true, result_template: true },
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

exports.createRestockRequest = async (req, res) => {
  const currentUser = req.user

  const {
    product_id, drug_stock_id, quantity,
    expiry_date, notes,
  } = req.body

  const productId = parseInt(product_id ?? drug_stock_id)
  const qty = parseInt(quantity)

  if (!Number.isInteger(productId)) {
    return res.status(400).json({ error: 'product_id is required' })
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'received quantity must be a positive whole number' })
  }

  let expiry = null
  if (expiry_date) {
    expiry = new Date(expiry_date)
    if (Number.isNaN(expiry.getTime())) {
      return res.status(400).json({ error: 'expiry_date is not a valid date' })
    }
    if (expiry.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'expiry_date must be in the future' })
    }
  }

  try {
    const product = await prisma.labStock.findUnique({ where: { id: productId } })
    if (!product) return res.status(404).json({ error: 'Product not found' })

       const existing = await prisma.restockRequest.findFirst({
      where: { department: 'lab', lab_stock_id: productId, status: 'pending' },
    })
    if (existing) {
      return res.status(409).json({
        error: `A restock request for ${product.name} is already awaiting approval`,
        request_id: existing.id,
      })
    }

    const created = await prisma.restockRequest.create({
      data: {
        department: 'lab',
        product_id: null,
        lab_stock_id: productId,
        quantity: qty,
        expiry_date: expiry,
        notes: (typeof notes === 'string' && notes.trim()) || null,
        status: 'pending',
        requested_by: currentUser?.username ?? 'unknown',
        requested_by_id: currentUser?.id ?? null,
      },
      include: RESTOCK_INCLUDE,
    })
    await createNotification({
      targetRoles: ['admin'],
      type: NOTIFICATION_TYPES.RESTOCK_REQUESTED,
      title: 'Restock request',
      message: `${currentUser?.username ?? 'Pharmacy'} requested ${qty} ${product.unit} of ${product.name} (current stock: ${product.current_stock}).`,
    })

    await writeAuditLog({
      staffId: currentUser?.id,   
      user: currentUser?.username,
      action: 'request_restock',
      description: `Requested ${qty} ${product.unit} of ${product.name}`,
      category: 'stock',
      entity: 'restock_request',
      entityId: created.id,
      ipAddress: req.ip ?? null,
    })

    return res.status(201).json({ success: true })

  } catch (err) {
    console.error('createRestockRequest', err.message)
    return res.status(500).json({ error: 'Failed to submit restock request' })
  }
}