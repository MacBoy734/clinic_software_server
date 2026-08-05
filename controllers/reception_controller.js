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

    referred_by: v.referred_by || null,
    referrer_phone: v.referrer_phone || null,

    patient_id: v.patient.id,
    patient_name: v.patient.name,
    phone: v.patient.phone,
    gender: v.patient.gender,
    age: v.patient.age ?? null,

    chief_complaint: v.notes || null,

    doctor: v.doctor?.username || null,
    doctor_id: v.doctor?.id || null,

    consultation_fee: v.bill?.consultation_fee ?? 0,
    consultation_fee_status: v.bill?.consultation_fee_status ?? 'pending',
    lab_fee: v.bill?.lab_fee ?? 0,
    medication_fee: v.bill?.medication_fee ?? 0,
    procedure_fee: v.bill?.procedure_fee ?? 0,
    stage2_status: v.bill?.stage2_status ?? 'pending',
    total_amount: v.bill?.total_amount ?? 0,
    fee_status: v.bill?.fee_status ?? 'pending',

    lab_requests: v.lab_requests,
    has_lab: v.lab_requests.length > 0,
    lab_done: v.lab_requests.length > 0 && v.lab_requests.every((r) => r.status === 'ready'),

    has_prescription: v.prescriptions.length > 0,
    // FIX: pharmacy sets status to 'issued', not 'dispensed'
    rx_dispensed: v.prescriptions.length > 0 && v.prescriptions.every((p) => p.status === 'issued' || p.status === 'dispensed'),
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
    const { status } = req.query
    const where = {
      arrived_at: todayRange(),
      status: { notIn: ['archived'] }
    }
    if (status && status !== 'all') {
      where.status = status
    }

    const visits = await prisma.visit.findMany({
      where,
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
      const items = [
        b.consultation_fee > 0 && { name: 'Consultation fee', amount: b.consultation_fee },
        b.lab_fee > 0 && { name: 'Lab fees', amount: b.lab_fee },
        b.medication_fee > 0 && { name: 'Medication', amount: b.medication_fee },
        b.procedure_fee > 0 && { name: 'Procedure fee', amount: b.procedure_fee },
      ].filter(Boolean)

      const paid_amount = b.payments.reduce((sum, p) => sum + p.amount, 0)
      const lastPayment = b.payments[b.payments.length - 1]
      const discount_amount = b.discount_amount || 0
      const payable_amount = b.total_amount - discount_amount

      return {
        id: b.id,
        visit_id: b.visit.id,
        visit_status: b.visit.status,
        visit_type: b.visit.visit_type,
        patient_name: b.visit.patient.name,
        patient_id: b.visit.patient.id,
        items,
        total_amount: b.total_amount,
        discount_amount,
        discount_reason: b.discount_reason || null,
        payable_amount,
        paid_amount,
        status: b.fee_status,
        method: lastPayment?.method ?? null,
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

  let visit

  try {
    const result = await prisma.$transaction(async (tx) => {
      visit = await tx.visit.findUnique({
        where: { id: Number(id) },
        include: { bill: true, patient: { select: { name: true } } },
      })

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
          // FIX: do NOT increment total_amount by the payment
        },
      })

      await tx.visit.update({
        where: { id: Number(id) },
        data: { status: 'consultation_paid' },
      })

      return { bill: updatedBill }
    })

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
    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    console.error('stage1Payment error:', error)
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
const PAYMENT_METHODS = ['cash', 'mpesa', 'insurance', 'other']
function normalizePayments(body) {
  // Split form
  if (Array.isArray(body.payments)) {
    return body.payments.map((p) => ({
      method: p.method,
      amount: Number(p.amount),
      reference: typeof p.reference === 'string' && p.reference.trim() ? p.reference.trim() : null,
    }))
  }
  // Legacy single form
  if (body.amount && body.method) {
    return [{
      method: body.method,
      amount: Number(body.amount),
      reference: typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim() : null,
    }]
  }
  return []
}

module.exports.collectPayment = async (req, res) => {
  const { visit_id, stage } = req.body
  const ip = req.ip ?? null
  const currentUser = req.user
  const io = getIO()

  if (!visit_id || !stage) {
    return res.status(400).json({ error: 'visit_id and stage are required' })
  }
  if (![1, 2].includes(Number(stage))) {
    return res.status(400).json({ error: 'stage must be 1 or 2' })
  }

  // ── Validate payment lines ─────────────────────────────────────────────────
  const lines = normalizePayments(req.body)
  if (!lines.length) {
    return res.status(400).json({ error: 'Provide at least one payment (payments[] or amount+method)' })
  }
  for (const [idx, p] of lines.entries()) {
    if (!PAYMENT_METHODS.includes(p.method)) {
      return res.status(400).json({ error: `Payment ${idx + 1}: invalid method '${p.method}'` })
    }
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      return res.status(400).json({ error: `Payment ${idx + 1}: amount must be a positive whole number (KSh)` })
    }
  }
  const paymentsSum = lines.reduce((s, p) => s + p.amount, 0)

  // ── Validate discount (stage 2 only) ───────────────────────────────────────
  const discount = Number(req.body.discount_amount) || 0
  const discountReason = typeof req.body.discount_reason === 'string' && req.body.discount_reason.trim()
    ? req.body.discount_reason.trim()
    : null
  if (discount < 0 || !Number.isInteger(discount)) {
    return res.status(400).json({ error: 'discount_amount must be a non-negative whole number' })
  }
  if (Number(stage) === 1 && discount > 0) {
    return res.status(400).json({ error: 'Discounts are applied at stage 2 (billing desk), not at consultation payment' })
  }
  if (discount > 0 && !discountReason) {
    return res.status(400).json({ error: 'A reason is required when applying a discount' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const httpError = (message, status = 400) =>
        Object.assign(new Error(message), { status })

      // Fresh read INSIDE the transaction — guards double-collection races.
      const visit = await tx.visit.findUnique({
        where: { id: Number(visit_id) },
        include: {
          bill: { include: { payments: { select: { amount: true } } } },
          patient: { select: { name: true } },
        },
      })

      if (!visit) throw httpError('Visit not found', 404)
      if (!visit.bill) throw httpError('No bill found for this visit', 404)

      const bill = visit.bill
      const cashierId = currentUser?.id ?? null
      const now = new Date()
      const alreadyPaid = bill.payments.reduce((s, p) => s + p.amount, 0)

      // ── Stage 1 — consultation fee, exact amount ─────────────────────────
      if (Number(stage) === 1) {
        if (bill.consultation_fee_status === 'paid') {
          throw httpError('Stage 1 payment already collected', 409)
        }
        if (paymentsSum !== bill.consultation_fee) {
          throw httpError(
            `Payments (${paymentsSum}) must equal the consultation fee (${bill.consultation_fee})`
          )
        }

        const stage2Total = bill.lab_fee + bill.medication_fee + bill.procedure_fee
        const overallStatus = stage2Total === 0 ? 'paid' : 'pending'

        await tx.payment.createMany({
          data: lines.map((p) => ({
            bill_id: bill.id,
            cashier_id: cashierId,
            amount: p.amount,
            method: p.method,
            reference: p.reference,
            stage: 1,
            paid_at: now,
          })),
        })

        await tx.bill.update({
          where: { id: bill.id },
          data: {
            consultation_fee_status: 'paid',
            consultation_fee_status_paid_at: now,
            fee_status: overallStatus,
          },
        })

        await tx.visit.update({
          where: { id: Number(visit_id) },
          data: { status: 'consultation_paid' },
        })

        return { stage: 1, visit, next_status: 'consultation_paid' }
      }

      // ── Stage 2 — remaining balance, minus discount, split allowed ───────
      if (bill.stage2_status === 'paid') {
        throw httpError('Stage 2 payment already collected', 409)
      }

      const effectiveConsultation = bill.consultation_fee_status === 'waived' ? 0 : bill.consultation_fee
      const billTotal = effectiveConsultation + bill.lab_fee + bill.medication_fee + bill.procedure_fee

      if (discount > billTotal - alreadyPaid) {
        throw httpError(`Discount (${discount}) cannot exceed the outstanding balance (${billTotal - alreadyPaid})`)
      }

      const required = billTotal - discount - alreadyPaid
      if (paymentsSum !== required) {
        throw httpError(
          `Payments (${paymentsSum}) must settle the outstanding balance exactly: ` +
          `total ${billTotal} − discount ${discount} − already paid ${alreadyPaid} = ${required}`
        )
      }

      await tx.payment.createMany({
        data: lines.map((p) => ({
          bill_id: bill.id,
          cashier_id: cashierId,
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          stage: 2,
          paid_at: now,
        })),
      })

      await tx.bill.update({
        where: { id: bill.id },
        data: {
          stage2_status: 'paid',
          stage2_paid_at: now,
          total_amount: billTotal,
          discount_amount: discount,
          discount_reason: discountReason,
          fee_status: 'paid',
        },
      })

      await tx.visit.update({
        where: { id: Number(visit_id) },
        data: { status: 'done' },
      })

      return { stage: 2, visit, next_status: 'done', billTotal, discount }
    })

    // ── Post-commit side effects — payment is durable; nothing here may fail
    //    the request ─────────────────────────────────────────────────────────
    const patientName = result.visit?.patient?.name ?? 'Unknown'
    const methodSummary = lines.map((p) => `${p.method} ${p.amount}`).join(' + ')

    try {
      await writeAuditLog({
        staffId: currentUser.id,
        user: currentUser.username,
        action: result.stage === 1 ? 'Stage 1 Payment' : 'Stage 2 Payment',
        description:
          `Stage ${result.stage} payment of ${paymentsSum} (${methodSummary})` +
          (result.stage === 2 && result.discount > 0 ? ` with discount ${result.discount} (${discountReason})` : '') +
          ` recorded for ${patientName} — visit #${visit_id}`,
        category: 'payment',
        ipAddress: ip,
      })

      if (result.stage === 1) {
        await createNotification({
          targetRoles: ['doctor'],
          type: NOTIFICATION_TYPES.VISIT_FORWARDED,
          visitId: Number(visit_id),
          title: 'Patient ready for consultation',
          message: `${patientName} has paid and is waiting for consultation.`,
          io,
        })
        io.to('doctor').emit('visit:new', { visit_id: Number(visit_id), patient_name: patientName })
      }

      if (result.stage === 2 && result.visit.visit_type === 'direct_lab') {
        // create a referral
        if (result?.visit?.referred_by?.trim() !== '') {
          await prisma.Referral.create({
            data: {
              visit_id: Number(visit_id),
              referrer_name: result?.visit?.referred_by.trim(),
              referrer_phone: result?.visit?.referrer_phone ?? null,
            }
          })
          await createNotification({
            targetRoles: ['admin'],
            type: NOTIFICATION_TYPES.REFERRED_PATIENT_PAID,
            title: 'Pending commission payment',
            visitId: result.visit.id,
            message: `${patientName} referred by ${result.visit?.referred_by || 'unknown'} has paid`,
            io,
          })
        }
        io.to('admin').emit('referral:new')
      }
    } catch (sideErr) {
      console.error('collectPayment post-commit side effect failed:', sideErr)
    }

    return res.json({
      success: true,
      next_status: result.next_status,
      message: result.stage === 1
        ? 'Stage 1 payment collected — patient ready for doctor'
        : 'Stage 2 payment collected — visit complete',
    })

  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    console.error('collectPayment error:', error)
    return res.status(500).json({ error: 'Failed to collect payment' })
  }
}

module.exports.waiveStage1 = async (req, res) => {
  const { id } = req.params
  const { reason } = req.body
  const currentUser = req.user
  const ip = req.ip ?? null
  const io = getIO()

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required to waive the consultation fee' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: Number(id) },
        include: { bill: true, patient: { select: { name: true } } },
      })

      if (!visit) throw Object.assign(new Error('Visit not found'), { status: 404 })
      if (!visit.bill) throw Object.assign(new Error('No bill found'), { status: 404 })
      if (visit.visit_type !== 'consultation') {
        throw Object.assign(new Error('Only consultation visits can have stage 1 waived'), { status: 400 })
      }
      if (visit.status !== 'waiting') {
        throw Object.assign(new Error(`Cannot waive — visit is already ${visit.status}`), { status: 400 })
      }
      if (visit.bill.consultation_fee_status === 'paid') {
        throw Object.assign(new Error('Stage 1 is already paid — use refund instead'), { status: 409 })
      }
      if (visit.bill.consultation_fee_status === 'waived') {
        throw Object.assign(new Error('Stage 1 is already waived'), { status: 409 })
      }

      await tx.bill.update({
        where: { id: visit.bill.id },
        data: {
          consultation_fee_status: 'waived',
          consultation_fee_waived_by: currentUser?.username ?? 'unknown',
          consultation_fee_waive_reason: String(reason).trim(),
          consultation_fee_waived_at: new Date(),
        },
      })

      await tx.visit.update({
        where: { id: Number(id) },
        data: { status: 'consultation_paid' },
      })

      return visit
    })

    const patientName = result.patient?.name ?? 'Unknown'

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'Waive Stage 1',
        description: `Waived consultation fee for ${patientName} — reason: ${String(reason).trim()}`,
        category: 'payment',
        entity: 'bill',
        entityId: result.bill.id,
        ipAddress: ip,
      })

      await createNotification({
        targetRoles: ['doctor'],
        type: NOTIFICATION_TYPES.VISIT_FORWARDED,
        visitId: Number(id),
        title: 'Patient ready for consultation',
        message: `${patientName} (consultation fee waived) is waiting for consultation.`,
        io,
      })

      io.to('doctor').emit('visit:new', {
        visit_id: Number(id),
        patient_name: patientName,
      })
    } catch (sideErr) {
      console.error('waiveStage1 post-commit side effect failed:', sideErr)
    }

    return res.json({
      success: true,
      message: 'Consultation fee waived — patient forwarded to doctor',
    })

  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    console.error('waiveStage1 error:', error)
    return res.status(500).json({ error: 'Failed to waive consultation fee' })
  }
}


module.exports.forwardToDoctor = (req, res) => updateVisitStatus(req, res, 'with_doctor')
module.exports.forwardToLab = (req, res) => updateVisitStatus(req, res, 'lab')
module.exports.forwardToBilling = (req, res) => updateVisitStatus(req, res, 'billing')
module.exports.markDone = (req, res) => updateVisitStatus(req, res, 'done')
module.exports.archiveVisit = (req, res) => updateVisitStatus(req, res, 'archived')