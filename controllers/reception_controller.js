const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')
const { todayRange, writeAuditLog, createNotification, NOTIFICATION_TYPES } = require('../utils/helpers')

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VISIT_INCLUDE = {
  patient: {
    select: { id: true, name: true, phone: true, gender: true, age: true }
  },
  bill: true,
  // CHANGED: test_name and unit_cost no longer live on LabRequest directly —
  // they moved to LabRequestItem (the `items` relation). LabRequest is now
  // just the order batch (urgency, who ordered it, overall status).
  lab_requests: {
    select: {
      id: true,
      urgency: true,
      status: true,
      ordered_by: true,
      requested_at: true,
      completed_at: true,
      items: {
        select: { id: true, test_name: true, category: true, unit_cost: true, result: true, status: true }
      }
    }
  },
  prescriptions: {
    select: { id: true, status: true }
  },
  doctor: {
    select: { id: true, username: true }
  },
}

function formatArrival(dt) {
  return new Date(dt).toLocaleTimeString('en-KE', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function shapeVisit(v) {
  return {
    id: v.id,
    queue_number: v.queue_number,
    visit_type: v.visit_type,
    status: v.status,
    arrived_at: formatArrival(v.arrived_at),

    // Referral - direct_lab only
    referred_by: v.referred_by || null,
    referrer_phone: v.referrer_phone || null,

    // Patient
    patient_id: v.patient.id,
    patient_name: v.patient.name,
    phone: v.patient.phone,
    gender: v.patient.gender,
    age: v.patient.age ?? null,

    // Complaint lives in notes (set at registration)
    chief_complaint: v.notes || null,

    // Doctor
    doctor: v.doctor?.username || null,
    doctor_id: v.doctor?.id || null,

    // Billing - safe defaults if bill missing
    consultation_fee: v.bill?.consultation_fee ?? 0,
    consultation_fee_status: v.bill?.consultation_fee_status ?? 'pending',
    lab_fee: v.bill?.lab_fee ?? 0,
    medication_fee: v.bill?.medication_fee ?? 0,
    procedure_fee: v.bill?.procedure_fee ?? 0,
    stage2_status: v.bill?.stage2_status ?? 'pending',
    total_amount: v.bill?.total_amount ?? 0,
    fee_status: v.bill?.fee_status ?? 'pending',

    // Lab
    lab_requests: v.lab_requests,
    has_lab: v.lab_requests.length > 0,
    lab_done: v.lab_requests.length > 0 && v.lab_requests.every((r) => r.status === 'ready'),

    // Prescriptions
    has_prescription: v.prescriptions.length > 0,
    rx_dispensed: v.prescriptions.length > 0 && v.prescriptions.every((p) => p.status === 'dispensed'),
  }
}

// --- GET /api/reception/visits ------------------------------------------------
// Query params: ?status=waiting  (optional - omit for all)
module.exports.getVisits = async (req, res) => {
  const { status } = req.query

  try {
    const where = {
      arrived_at: todayRange(),
      status: { not: 'archived' },
    }

    if (status && status !== 'all') {
      where.status = status
    }

    const visits = await prisma.visit.findMany({
      where,
      orderBy: { arrived_at: 'asc' },
      include: VISIT_INCLUDE,
    })

    return res.json({ visits: visits.map(shapeVisit) })

  } catch (err) {
    console.error('getVisits error:', err)
    return res.status(500).json({ error: 'Failed to fetch visits' })
  }
}

// ─── GET /api/reception/queue ─────────────────────────────────────────────────

module.exports.getQueue = async (req, res) => {
  try {
    const visits = await prisma.visit.findMany({
      where: {
        arrived_at: todayRange(),
        status: { notIn: ['archived'] }
      },
      include: VISIT_INCLUDE,
      orderBy: [{ queue_number: 'asc' }, { arrived_at: 'asc' }],
    })
    return res.json(visits)
  } catch (error) {
    console.error('getQueue error:', error)
    return res.status(500).json({ error: 'Failed to fetch queue' })
  }
}

// ─── GET /api/reception/stats ─────────────────────────────────────────────────

module.exports.getStats = async (req, res) => {
  try {
    const range = todayRange()

    const [total, done, waiting, revenue] = await Promise.all([
      prisma.visit.count({ where: { arrived_at: range } }),
      prisma.visit.count({ where: { arrived_at: range, status: 'done' } }),
      prisma.visit.count({ where: { arrived_at: range, status: 'waiting' } }),
      prisma.payment.aggregate({
        where: { paid_at: range },
        _sum: { amount: true },
      }),
    ])

    return res.json({
      total_visits: total,
      done,
      waiting,
      revenue_today: revenue._sum.amount || 0,
    })
  } catch (error) {
    console.error('getStats error:', error)
    return res.status(500).json({ error: 'Failed to fetch stats' })
  }
}

// ─── GET /api/reception/patients/search?q= ───────────────────────────────────

module.exports.searchPatients = async (req, res) => {
  const { q } = req.query
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' })
  }
  try {
    const patients = await prisma.patient.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { national_id: { contains: q, mode: 'insensitive' } },
        ]
      },
      select: {
        id: true, name: true, phone: true,
        gender: true, age: true, national_id: true,
      },
      take: 10,
    })
    return res.json(patients)
  } catch (error) {
    console.error('searchPatients error:', error)
    return res.status(500).json({ error: 'Failed to search patients' })
  }
}

// ─── GET /api/reception/charge-templates?category= ───────────────────────────

module.exports.getChargeTemplates = async (req, res) => {
  const { category } = req.query
  try {
    const templates = await prisma.chargeTemplate.findMany({
      where: {
        is_active: true,
        ...(category ? { category } : {}),
      },
      orderBy: { name: 'asc' },
    })
    return res.json(templates)
  } catch (error) {
    console.error('getChargeTemplates error:', error)
    return res.status(500).json({ error: 'Failed to fetch charge templates' })
  }
}

// ─── GET /api/reception/bills ─────────────────────────────────────────────────
// FIXED: previous version fetched payments with take:1 select:{method} but then
// summed p.amount — amount was never selected, so paid_amount was NaN for every
// bill with a payment. Now fetches ALL payments with full fields; this is also
// what the ReceiptModal needs to render payment history.
module.exports.getBills = async (req, res) => {
  try {
    const bills = await prisma.bill.findMany({
      where: {
        visit: { arrived_at: todayRange() }
      },
      include: {
        visit: {
          select: {
            id: true,
            status: true,
            visit_type: true,
            arrived_at: true,
            referred_by: true,
            patient: {
              select: { id: true, name: true }
            },
          }
        },
        payments: {
          orderBy: { paid_at: 'asc' },
          select: { amount: true, method: true, reference: true, stage: true, paid_at: true }
        }
      },
      orderBy: { created_at: 'asc' }
    })

    const shaped = bills.map((b) => {
      // Build itemized breakdown
      const items = [
        b.consultation_fee > 0 && { name: 'Consultation fee', amount: b.consultation_fee },
        b.lab_fee > 0 && { name: 'Lab fees', amount: b.lab_fee },
        b.medication_fee > 0 && { name: 'Medication', amount: b.medication_fee },
        b.procedure_fee > 0 && { name: 'Procedure fee', amount: b.procedure_fee },
      ].filter(Boolean)

      // Total paid = sum of all payments
      const paid_amount = b.payments.reduce((sum, p) => sum + p.amount, 0)
      const lastPayment = b.payments[b.payments.length - 1]

      return {
        id: b.id,
        visit_id: b.visit.id,
        visit_status: b.visit.status,
        visit_type: b.visit.visit_type,
        patient_name: b.visit.patient.name,
        patient_id: b.visit.patient.id,
        items,
        total_amount: b.total_amount,
        paid_amount,
        status: b.fee_status,
        method: lastPayment?.method ?? null,
        // Full payment history — consumed by ReceiptModal
        payments: b.payments.map((p) => ({
          amount: p.amount,
          method: p.method,
          reference: p.reference ?? null,
          stage: p.stage,
          paid_at: p.paid_at,
        })),
        created_at: b.created_at,
      }
    })

    return res.json(shaped)
  } catch (error) {
    console.error('getBills error:', error)
    return res.status(500).json({ error: 'Failed to fetch bills' })
  }
}

// ─── POST /api/reception/register ────────────────────────────────────────────

module.exports.registerVisit = async (req, res) => {
  const {
    patient_id,
    patient: newPatient,
    visit_type,
    referred_by,
    referrer_phone,
    lab_test_ids = [],
  } = req.body

  const httpError = (message, status = 400) =>
    Object.assign(new Error(message), { status })

  // req.ip only; requires app.set('trust proxy', ...). Never read the header
  // directly — it is spoofable.
  const ip = req.ip ?? null
  const currentUser = req.user
  const io = getIO()

  if (!visit_type) {
    return res.status(400).json({ error: 'visit_type is required' })
  }
  if (!patient_id && !newPatient) {
    return res.status(400).json({ error: 'Provide patient_id or patient details' })
  }
  if (visit_type === 'direct_lab' && lab_test_ids.length === 0) {
    return res.status(400).json({ error: 'Select at least one lab test for direct lab visits' })
  }

  const labIds = [...new Set(lab_test_ids.map(Number))]
  if (labIds.some((n) => !Number.isInteger(n) || n < 1)) {
    return res.status(400).json({ error: 'Invalid lab test id' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {

      // Serialize registration: tx.visit.count() + 1 does NOT serialize under
      // Read Committed, and queue_number has no unique constraint. One advisory
      // lock held for the transaction serializes all registrations (fine at
      // clinic volume) and also collapses the duplicate-patient / national_id
      // races below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('visit-registration'))`

      const todayCount = await tx.visit.count({ where: { arrived_at: todayRange() } })

      // Consultation fee from ChargeTemplate — never trust the client.
      let consultationFee = 0
      if (visit_type === 'consultation') {
        const template = await tx.chargeTemplate.findFirst({
          where: { category: 'consultation', is_active: true },
        })
        if (!template) {
          throw httpError('No active consultation fee configured. Set one in charge templates.')
        }
        consultationFee = template.amount
      }

      // Resolve lab tests from catalog — name and price come from DB.
      let labItems = []
      if (labIds.length > 0) {
        const catalogEntries = await tx.labTestCatalog.findMany({
          where: { id: { in: labIds }, is_active: true },
          select: { id: true, name: true, unit_cost: true },
        })
        if (catalogEntries.length !== labIds.length) {
          throw httpError('One or more selected lab tests are invalid or inactive')
        }
        labItems = catalogEntries
      }

      // Resolve patient — whitelist + validate, no mass assignment.
      let pid = patient_id

      if (!pid && newPatient) {
        const { name, gender, age, phone, national_id } = newPatient ?? {}

        if (!name || !name.trim()) throw httpError('Patient name is required')
        if (!['male', 'female', 'other'].includes(gender)) throw httpError('Valid gender is required')

        const ageNum = Number(age)
        if (!Number.isInteger(ageNum) || ageNum < 1 || ageNum > 110) {
          throw httpError('Valid age (1-110) is required')
        }

        const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

        const patientData = {
          name: name.trim(),
          gender,
          age: ageNum,
          phone: str(phone),
          national_id: str(national_id),
        }

        if (patientData.national_id) {
          const existing = await tx.patient.findUnique({
            where: { national_id: patientData.national_id },
          })
          if (existing) pid = existing.id
        }

        if (!pid) {
          const created = await tx.patient.create({ data: patientData })
          pid = created.id
        }
      }

      if (!pid) throw httpError('Could not resolve patient')

      const labFeeTotal = labItems.reduce((sum, t) => sum + (t.unit_cost || 0), 0)

      const billData = {
        consultation_fee: consultationFee,
        consultation_fee_status: visit_type === 'consultation' ? 'pending' : 'waived',
        lab_fee: labFeeTotal,
        medication_fee: 0,
        procedure_fee: 0,
        total_amount: consultationFee + labFeeTotal,
        fee_status: 'pending',
        stage2_status: 'pending',
      }

      // injection / family_planning reuse 'consultation_paid' to route to the
      // doctor despite no fee paid; a dedicated status would be clearer.
      const initialStatus =
        visit_type === 'consultation' ? 'waiting' :
          visit_type === 'direct_lab' ? 'lab' :
            'consultation_paid'

      const visit = await tx.visit.create({
        data: {
          patient_id: pid,
          visit_type,
          status: initialStatus,
          queue_number: todayCount + 1,
          referred_by: visit_type === 'direct_lab' ? (referred_by || null) : null,
          referrer_phone: visit_type === 'direct_lab' ? (referrer_phone || null) : null,
          bill: { create: billData },

          ...(labItems.length > 0 && {
            lab_requests: {
              create: [{
                status: 'pending',
                ordered_by: referred_by || 'Self',
                items: {
                  create: labItems.map((t) => ({
                    test_name: t.name,       // snapshot
                    unit_cost: t.unit_cost,  // snapshot
                    catalog_id: t.id,        // FK for reference range / result template
                    status: 'pending',
                  })),
                },
              }],
            },
          }),
        },
        include: VISIT_INCLUDE,
      })

      return visit
    })

    // Post-commit side effects: result is durable. Nothing here may fail the
    // request — a broken notification must not report a 500 and cause a
    // duplicate re-registration.
    const patientName = result.patient?.name ?? 'Unknown'

    const slim = {
      id: result.id,
      queue_number: result.queue_number,
      visit_type,
      status: result.status,
      patient_name: patientName,
      arrived_at: result.arrived_at,
    }

    try {
      await writeAuditLog({
        staffId: currentUser.id,
        user: currentUser.username,
        action: 'Register Patient',
        description: `Registered patient: ${patientName} — visit type: ${visit_type}`,
        category: 'patient',
        ipAddress: ip,
      })

      if (visit_type === 'direct_lab') {
        await createNotification({
          targetRoles: ['lab_tech'],
          type: NOTIFICATION_TYPES.NEW_PATIENT,
          title: 'New patient registered',
          visitId: result.id,
          message: `${patientName} registered for direct lab`,
          io,
        })
        io.to('lab_tech').emit('visit:new', slim)
      }

      if (visit_type === 'injection' || visit_type === 'family_planning') {
        await createNotification({
          targetRoles: ['doctor'],
          type: NOTIFICATION_TYPES.NEW_PATIENT,
          title: 'New patient registered',
          visitId: result.id,
          message: `${patientName} registered for ${visit_type.replace('_', ' ')}`,
          io,
        })
        io.to('doctor').emit('visit:new', slim)
      }
    } catch (sideErr) {
      console.error('registerVisit post-commit side effect failed:', sideErr)
    }

    return res.status(201).json(result)

  } catch (error) {
    console.error('registerVisit error:', error)

    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    if (error.code === 'P2002' && error.meta?.target?.includes('national_id')) {
      return res.status(409).json({
        error: 'A patient with this national ID already exists. Use patient search instead.',
      })
    }
    return res.status(500).json({ error: 'Failed to register visit' })
  }
}

// ─── PATCH /api/reception/visits/:id/stage1-payment ──────────────────────────

module.exports.stage1Payment = async (req, res) => {
  const { id } = req.params
  const { amount, method, reference } = req.body
  const cashier_id = req.user?.id
  const ip = req.ip ?? null
  const io = getIO()

  if (!id) return res.status(400).json({ error: 'Visit ID is required' })
  if (!amount || !method) return res.status(400).json({ error: 'Amount and method are required' })

  // Declare visit here so it's accessible outside the transaction
  let visit

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Assign to outer visit so it's accessible after the transaction
      visit = await tx.visit.findUnique({
        where: { id: Number(id) },
        include: { bill: true, patient: { select: { name: true } } },
      })

      // Throw instead of returning — this aborts the transaction cleanly
      if (!visit) throw Object.assign(new Error('Visit not found'), { status: 404 })
      if (!visit.bill) throw Object.assign(new Error('No bill found for this visit'), { status: 404 })

      if (visit.status !== 'waiting') {
        throw Object.assign(
          new Error(`Cannot collect stage 1 payment for visit with status: ${visit.status}`),
          { status: 400 }
        )
      }

      await tx.payment.create({
        data: {
          bill_id: visit.bill.id,
          cashier_id,
          amount: Number(amount),
          method,
          reference: reference || null,
          stage: 1,
        },
      })

      const updatedBill = await tx.bill.update({
        where: { id: visit.bill.id },
        data: {
          consultation_fee_status: 'paid',
          consultation_fee_status_paid_at: new Date(),
          total_amount: {
            increment: Number(amount),
          },
        },
      })

      await tx.visit.update({
        where: { id: Number(id) },
        data: { status: 'consultation_paid' },
      })

      return { bill: updatedBill }
    })

    // Post-commit side effects — payment is durable; nothing here may fail
    // the request.
    const patientName = visit?.patient?.name ?? 'Unknown'

    try {
      await writeAuditLog({
        staffId: cashier_id,
        user: req.user?.username,
        action: 'Stage 1 Payment',
        description: `Stage 1 payment of ${amount} (${method}) recorded for ${patientName} — visit #${id}`,
        category: 'payment',
        ipAddress: ip,
      })

      await createNotification({
        targetRoles: ['doctor'],
        type: NOTIFICATION_TYPES.VISIT_FORWARDED,
        visitId: Number(id),
        title: 'Patient ready for consultation',
        message: `${patientName} has paid and is waiting for consultation.`,
        io,
      })

      io.to('doctor').emit('visit:new', {
        visit_id: Number(id),
        patient_name: patientName,
      })
    } catch (sideErr) {
      console.error('stage1Payment post-commit side effect failed:', sideErr)
    }

    return res.json({ message: 'Stage 1 payment recorded', bill: result.bill })

  } catch (error) {
    // Handle known errors thrown from inside the transaction
    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    console.error('stage1Payment error:', error)
    return res.status(500).json({ error: 'Failed to record payment' })
  }
}

// ─── PATCH /api/reception/visits/:id/stage2-payment ──────────────────────────
// NOTE: BillingTab uses collectPayment (PATCH /api/reception/payments) for
// stage 2, not this route. Keep only one of these long-term or they will drift.

module.exports.stage2Payment = async (req, res) => {
  const { id } = req.params
  const { amount, method, reference } = req.body
  const cashier_id = req.user?.id

  if (!amount || !method) {
    return res.status(400).json({ error: 'Amount and method are required' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: Number(id) },
        include: { bill: true }
      })
      if (!visit) return { error: 'Visit not found', status: 404 }
      if (!visit.bill) return { error: 'No bill found', status: 400 }

      await tx.payment.create({
        data: {
          bill_id: visit.bill.id,
          cashier_id,
          amount,
          method,
          reference,
          stage: 2,
        }
      })

      const updated = await tx.bill.update({
        where: { id: visit.bill.id },
        data: {
          stage2_status: 'paid',
          stage2_paid_at: new Date(),
          fee_status: 'paid',
        }
      })

      await tx.visit.update({
        where: { id: Number(id) },
        data: { status: 'done' }
      })

      return updated
    })

    if (result.error) return res.status(result.status).json({ error: result.error })
    return res.json({ message: 'Stage 2 payment recorded', bill: result })
  } catch (error) {
    console.error('stage2Payment error:', error)
    return res.status(500).json({ error: 'Failed to record payment' })
  }
}

// ─── Status transition helpers ────────────────────────────────────────────────

async function updateVisitStatus(req, res, status) {
  const { id } = req.params
  try {
    const visit = await prisma.visit.update({
      where: { id: Number(id) },
      data: { status },
      include: VISIT_INCLUDE,
    })
    return res.json(visit)
  } catch (error) {
    console.error(`updateVisitStatus(${status}) error:`, error)
    return res.status(500).json({ error: 'Failed to update visit status' })
  }
}

// ─── PATCH /api/reception/payments ────────────────────────────────────────────

module.exports.collectPayment = async (req, res) => {
  const { visit_id, amount, method, reference, stage } = req.body
  const ip = req.ip ?? null
  const currentUser = req.user
  const io = getIO()

  if (!visit_id || !amount || !method || !stage) {
    return res.status(400).json({
      error: 'visit_id, amount, method and stage are required',
    })
  }

  if (![1, 2].includes(Number(stage))) {
    return res.status(400).json({ error: 'stage must be 1 or 2' })
  }

  try {
    const visit = await prisma.visit.findUnique({
      where: { id: Number(visit_id) },
      include: { bill: true, patient: true },
    })

    if (!visit) return res.status(404).json({ error: 'Visit not found' })
    if (!visit.bill) return res.status(404).json({ error: 'No bill found for this visit' })

    const bill = visit.bill
    const cashierId = req.user?.userId || null
    const now = new Date()

    // ── Stage 1 ──────────────────────────────────────────────────────────────
    if (Number(stage) === 1) {
      if (bill.consultation_fee_status === 'paid') {
        return res.status(409).json({ error: 'Stage 1 payment already collected' })
      }

      // If no stage 2 charges exist yet, mark overall as paid immediately
      const stage2Total = bill.lab_fee + bill.medication_fee + bill.procedure_fee
      const overallStatus = stage2Total === 0 ? 'paid' : 'pending'

      await prisma.$transaction([
        prisma.payment.create({
          data: {
            bill_id: bill.id,
            cashier_id: cashierId,
            amount: Number(amount),
            method,
            reference: reference || null,
            stage: 1,
            paid_at: now,
          },
        }),

        prisma.bill.update({
          where: { id: bill.id },
          data: {
            consultation_fee_status: 'paid',
            consultation_fee_status_paid_at: now,
            fee_status: overallStatus,
          },
        }),

        prisma.visit.update({
          where: { id: Number(visit_id) },
          data: { status: 'consultation_paid' },
        }),
      ])

      return res.json({
        success: true,
        next_status: 'consultation_paid',
        message: 'Stage 1 payment collected — patient ready for doctor',
      })
    }

    // ── Stage 2 ──────────────────────────────────────────────────────────────
    if (bill.stage2_status === 'paid') {
      return res.status(409).json({ error: 'Stage 2 payment already collected' })
    }

    // Recalculate total including both stages
    const stage2Total = bill.lab_fee + bill.medication_fee + bill.procedure_fee
    const totalAmount = bill.consultation_fee + stage2Total

    await prisma.$transaction([
      prisma.payment.create({
        data: {
          bill_id: bill.id,
          cashier_id: cashierId,
          amount: Number(amount),
          method,
          reference: reference || null,
          stage: 2,
          paid_at: now,
        },
      }),

      prisma.bill.update({
        where: { id: bill.id },
        data: {
          stage2_status: 'paid',
          stage2_paid_at: now,
          total_amount: totalAmount,
          fee_status: 'paid',
        },
      }),

      prisma.visit.update({
        where: { id: Number(visit_id) },
        data: { status: 'done' },
      }),
    ])

    // Post-commit side effects — payment is durable; nothing here may fail
    // the request. FIXED: previous version had a bare `unknown` identifier
    // (ReferenceError) that crashed AFTER the money committed, reporting a
    // false 500 for a successful payment.
    try {
      await writeAuditLog({
        staffId: currentUser.id,
        user: currentUser.username,
        action: 'Stage 2 Payment',
        description: `Stage 2 payment of ${amount} (${method}) recorded for ${visit.patient.name} — visit #${visit_id}`,
        category: 'payment',
        ipAddress: ip,
      })

      if (visit.visit_type === 'direct_lab') {
        await createNotification({
          targetRoles: ['admin'],
          type: NOTIFICATION_TYPES.REFERRED_PATIENT_PAID,
          title: 'Pending commission payment',
          visitId: visit.id,
          message: `${visit?.patient?.name || 'Unknown'} referred by ${visit?.referred_by || 'unknown'} has paid`,
          io,
        })
        io.to('admin').emit('payment:referred_patient_paid')
      }
    } catch (sideErr) {
      console.error('collectPayment post-commit side effect failed:', sideErr)
    }

    return res.json({
      success: true,
      next_status: 'done',
      message: 'Stage 2 payment collected — visit complete',
    })

  } catch (err) {
    console.error('collectPayment error:', err.message)
    return res.status(500).json({ error: 'Failed to collect payment' })
  }
}


module.exports.forwardToDoctor = (req, res) => updateVisitStatus(req, res, 'with_doctor')
module.exports.forwardToLab = (req, res) => updateVisitStatus(req, res, 'lab')
module.exports.forwardToBilling = (req, res) => updateVisitStatus(req, res, 'billing')
module.exports.markDone = (req, res) => updateVisitStatus(req, res, 'done')
module.exports.archiveVisit = (req, res) => updateVisitStatus(req, res, 'archived')