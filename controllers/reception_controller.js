const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')
const { todayRange, writeAuditLog, createNotification, NOTIFICATION_TYPES } = require('../utils/helpers')

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VISIT_INCLUDE = {
  patient: {
    select: { id: true, name: true, phone: true, gender: true, age: true }
  },
  bill: true,
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
      orderBy: [{ arrived_at: 'desc' }],
    })
    return res.json(visits)
  } catch (error) {
    console.error('getQueue error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch queue' })
  }
}

// ─── GET /api/reception/stats ─────────────────────────────────────────────────

module.exports.getStats = async (req, res) => {
  try {
    const range = todayRange();

    const [total, done, waiting, payments] = await Promise.all([
      prisma.visit.count({ where: { arrived_at: range } }),
      prisma.visit.count({ where: { arrived_at: range, status: 'done' } }),
      prisma.visit.count({ where: { arrived_at: range, status: 'waiting' } }),
      prisma.payment.groupBy({
        by: ['method'],
        where: { paid_at: range },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const by_method = { cash: 0, mpesa: 0, insurance: 0, credit: 0, other: 0 };
    const counts = { cash: 0, mpesa: 0, insurance: 0, credit: 0, other: 0 };
    let revenue_today = 0;

    for (const p of payments) {
      const amount = p._sum.amount ?? 0;
      by_method[p.method] = amount;
      counts[p.method] = p._count._all;
      revenue_today += amount;
    }

    return res.json({
      total_visits: total,
      done,
      waiting,
      revenue_today,
      payments: {
        by_method,
      },
    });
  } catch (error) {
    console.error('getStats error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

// ─── GET /api/reception/patients/search?q= ───────────────────────────────────

module.exports.searchPatients = async (req, res) => {
  const { q } = req.query
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

// ─── GET /api/reception/bills ────────────────────────────────────────────────

module.exports.getBills = async (req, res) => {
  try {
    const currentUser = req.user
    const bills = await prisma.bill.findMany({
      where: {
        visit: { status: { in: ['done', 'archived', 'billing'] } },
        OR: [
          { stage2_status: 'pending' },
          { fee_status: 'paid', stage2_paid_at: todayRange() },
          { fee_status: 'paid', stage2_waived_at: todayRange() }
        ]
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
          select: { amount: true, method: true, reference: true, stage: true, paid_at: true, cashier: { select: { username: true } } }
        }
      },
      orderBy: { created_at: 'asc' }
    })

    const shaped = bills.map((b) => {
      const items = [
        b.visit.visit_type === 'consultation' && {
          name: 'Consultation fee',
          amount: b.consultation_fee,
          status: b.consultation_fee_status,
        },
        b.lab_fee > 0 && {
          name: 'Lab fees',
          amount: b.lab_fee,
          status: b.stage2_status,
        },
        b.medication_fee > 0 && {
          name: 'Medication',
          amount: b.medication_fee,
          status: b.stage2_status,
        },
        b.procedure_fee > 0 && {
          name: 'Procedure fee',
          amount: b.procedure_fee,
          status: b.stage2_status,
        },
      ].filter(Boolean)

      const paid_amount = b.payments.reduce((sum, p) => sum + p.amount, 0)
      const lastPayment = b.payments[b.payments.length - 1]
      const lastCashier = lastPayment?.cashier?.username ?? currentUser?.username ?? 'receptionist'
      const discount_amount = b.discount_amount || 0

      // Effective total: waived fees count as 0
      const effectiveConsultation =
        b.consultation_fee_status === 'waived' ? 0 : b.consultation_fee
      const effectiveStage2 =
        b.stage2_status === 'waived' ? 0 : b.lab_fee + b.medication_fee + b.procedure_fee
      const effective_total = effectiveConsultation + effectiveStage2

      const payable_amount = Math.max(0, effective_total - discount_amount - paid_amount)

      return {
        id: b.id,
        cashier: lastCashier,
        visit_id: b.visit.id,
        visit_status: b.visit.status,
        visit_type: b.visit.visit_type,
        patient_name: b.visit.patient.name,
        patient_id: b.visit.patient.id,
        items,
        total_amount: b.total_amount,           // nominal total (services rendered)
        effective_total,                        // what patient actually owes
        discount_amount,
        discount_reason: b.discount_reason || null,
        payable_amount,
        paid_amount,
        stage2_status: b.stage2_status,
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
    console.error('getBills error:', error.message)
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
    lab_test_ids,
  } = req.body

  const httpError = (message, status = 400) =>
    Object.assign(new Error(message), { status })

  const ip = req.ip ?? null
  const currentUser = req.user
  const io = getIO()

  const labIds = [...new Set(lab_test_ids)]

  try {
    const result = await prisma.$transaction(async (tx) => {

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('visit-registration'))`

      const todayCount = await tx.visit.count({ where: { arrived_at: todayRange() } })

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

      let pid = patient_id

      if (!pid && newPatient) {
        const patientData = {
          name: newPatient.name,
          gender: newPatient.gender,
          age: newPatient.age,
          age_unit: newPatient.age_unit ?? 'years',
          phone: newPatient.phone ?? null,
          national_id: newPatient.national_id ?? null,
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

      const labFeeTotal = labItems.reduce((sum, t) => sum + t.unit_cost, 0)

      const billData = {
        consultation_fee_status: visit_type === 'consultation' ? 'pending' : 'waived',
        lab_fee: labFeeTotal,
        total_amount: labFeeTotal,
      }

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
                    test_name: t.name,
                    unit_cost: t.unit_cost,
                    catalog_id: t.id,
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
      console.error('registerVisit post-commit side effect failed:', sideErr.message)
    }

    return res.status(201).json(result)

  } catch (error) {
    console.error('registerVisit error:', error.message)

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


async function updateVisitStatus(req, res, status) {
  const { id } = req.params
  try {
    const visit = await prisma.visit.update({
      where: { id },
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
  const { visit_id, stage, payments, discount_amount, discount_reason } = req.body
  const ip = req.ip ?? null
  const currentUser = req.user
  const io = getIO()

  try {
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'At least one payment line is required' })
    }
    if (![1, 2].includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage. Must be 1 or 2' })
    }

    const paymentsSum = payments.reduce((s, p) => s + (parseInt(p.amount) || 0), 0)
    if (paymentsSum <= 0) {
      return res.status(400).json({ error: 'Payment amount must be greater than 0' })
    }

    // An omitted discount would make `required` NaN, which silently passes
    // every comparison below and records a full payment as unpaid.
    const discount = Number(discount_amount) || 0

    const result = await prisma.$transaction(async (tx) => {
      const httpError = (message, status = 400) =>
        Object.assign(new Error(message), { status })

      // Lock the bill row BEFORE reading it. Two cashiers on the same bill
      // would otherwise both read the same alreadyPaid, both pass the
      // over-payment guard, then serialise here and both write.
      await tx.$executeRaw`SELECT id FROM bills WHERE visit_id = ${visit_id} FOR UPDATE`

      const visit = await tx.visit.findUnique({
        where: { id: visit_id },
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

      // ── STAGE 1 ───────────────────────────────────────────────────
      if (stage === 1) {
        if (visit.visit_type !== 'consultation') {
          throw httpError('Stage 1 payment only applies to consultation visits', 400)
        }
        if (visit.status !== 'waiting') {
          throw httpError(`Cannot collect stage 1 payment for visit status: ${visit.status}`, 400)
        }
        if (bill.consultation_fee_status === 'paid') {
          throw httpError('Stage 1 payment already collected', 409)
        }
        if (bill.consultation_fee_status === 'waived') {
          throw httpError('Consultation fee is waived — use stage 2 or refund', 409)
        }

        await tx.payment.createMany({
          data: payments.map((p) => ({
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
            consultation_fee: paymentsSum,
            consultation_fee_status_paid_at: now,
          },
        })

        await tx.visit.update({
          where: { id: visit_id },
          data: { status: 'consultation_paid' },
        })

        return { stage: 1, visit, next_status: 'consultation_paid' }
      }

      // ── STAGE 2 ───────────────────────────────────────────────────
      // A partially paid visit sits at 'partially_paid', so it must be able
      // to come back and top up.
      if (!['billing', 'partially_paid'].includes(visit.status)) {
        throw httpError(
          `Stage 2 payment can only be collected when the visit is at billing. Current status: ${visit.status}`,
          400
        )
      }
      if (bill.stage2_status === 'paid') {
        throw httpError('Stage 2 payment already collected', 409)
      }
      if (visit.visit_type === 'consultation' && bill.consultation_fee_status === 'pending') {
        throw httpError('Stage 1 must be paid or waived before stage 2', 400)
      }

      const billTotal =
        bill.consultation_fee + bill.lab_fee + bill.medication_fee + bill.procedure_fee

      if (discount > billTotal - alreadyPaid) {
        throw httpError(
          `Discount (${discount}) cannot exceed the outstanding balance (${billTotal - alreadyPaid})`
        )
      }

      const required = billTotal - discount - alreadyPaid
      if (paymentsSum > required) {
        throw httpError(`Payments (${paymentsSum}) exceed the outstanding balance (${required})`)
      }

      await tx.payment.createMany({
        data: payments.map((p) => ({
          bill_id: bill.id,
          cashier_id: cashierId,
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          stage: 2,
          paid_at: now,
        })),
      })

      const newTotalPaid = alreadyPaid + paymentsSum
      const remainingBalance = Math.max(0, billTotal - discount - newTotalPaid)
      const isFullyPaid = remainingBalance <= 0
      const isConsultationResolved = ['paid', 'waived'].includes(bill.consultation_fee_status)
      const isStage2Resolved = isFullyPaid || bill.stage2_status === 'waived'
      const overallStatus = isConsultationResolved && isStage2Resolved ? 'paid' : 'pending'

      await tx.bill.update({
        where: { id: bill.id },
        data: {
          stage2_status: isFullyPaid ? 'paid' : 'pending',
          stage2_paid_at: isFullyPaid ? now : null,
          total_amount: billTotal,
          discount_amount: discount,
          discount_reason: discount_reason ?? null,
          fee_status: overallStatus,
        },
      })

      // Clinically finished either way — only the money decides which.
      await tx.visit.update({
        where: { id: visit_id },
        data: { status: isFullyPaid ? 'done' : 'partially_paid' },
      })

      return {
        stage: 2,
        visit,
        next_status: isFullyPaid ? 'done' : 'partially_paid',
        billTotal,
        discount,
        paid: newTotalPaid,
        remaining: remainingBalance,
      }
    })

    const patientName = result.visit?.patient?.name ?? 'Unknown'
    const methodSummary = payments.map((p) => `${p.method} ${p.amount}`).join(' + ')

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: result.stage === 1 ? 'Stage 1 Payment' : 'Stage 2 Payment',
        description:
          `Stage ${result.stage} payment of ${paymentsSum} (${methodSummary})` +
          (result.stage === 2 && result.discount > 0
            ? ` with discount ${result.discount} (${discount_reason})`
            : '') +
          (result.remaining > 0 ? ` — partial, balance ${result.remaining}` : '') +
          ` recorded for ${patientName} — visit #${visit_id}`,
        category: 'payment',
        ipAddress: ip,
      })

      if (result.stage === 1) {
        await createNotification({
          targetRoles: ['doctor'],
          type: NOTIFICATION_TYPES.VISIT_FORWARDED,
          visitId: visit_id,
          title: 'Patient ready for consultation',
          message: `${patientName} is waiting for consultation.`,
          io,
        })
        io.to('doctor').emit('visit:new', { visit_id, patient_name: patientName })
      }

      if (result.stage === 2 && result.visit.visit_type === 'direct_lab') {
        const referrer = result.visit.referred_by?.trim()
        if (referrer) {
          await prisma.referral.create({
            data: {
              visit_id,
              referrer_name: referrer,
              referrer_phone: result.visit.referrer_phone?.trim() || null,
            },
          })
          await createNotification({
            targetRoles: ['admin'],
            type: NOTIFICATION_TYPES.REFERRED_PATIENT_PAID,
            title: 'Pending commission payment',
            visitId: result.visit.id,
            message: `${patientName} referred by ${referrer} has paid`,
            io,
          })
          io.to('admin').emit('referral:new')
        }
      }
    } catch (sideErr) {
      console.error('collectPayment post-commit side effect failed:', sideErr.message)
    }

    return res.json({
      success: true,
      next_status: result.next_status,
      message:
        result.stage === 1
          ? 'Stage 1 payment collected — patient ready for doctor'
          : result.remaining > 0
            ? `Partial payment recorded — balance ${result.remaining}`
            : 'Stage 2 payment collected — visit complete',
    })
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    console.error('collectPayment error:', error.message)
    return res.status(500).json({ error: 'Failed to collect payment' })
  }
}

// ─── PATCH /api/reception/visits/:id/waive-stage1 ────────────────────────────

module.exports.waivePayment = async (req, res) => {
  const { id } = req.params
  const { stage, reason } = req.body
  const currentUser = req.user
  const ip = req.ip ?? null
  const io = getIO()

  try {
    const result = await prisma.$transaction(async (tx) => {
      const httpError = (message, status = 400) =>
        Object.assign(new Error(message), { status })

      if (![1, 2].includes(stage)) {
        throw httpError('stage must be 1 or 2', 400)
      }

      const visit = await tx.visit.findUnique({
        where: { id },
        include: {
          bill: true,
          patient: { select: { name: true } },
        },
      })

      if (!visit) throw httpError('Visit not found', 404)
      if (!visit.bill) throw httpError('No bill found', 404)
      // ── ROW LOCK ──────────────────────────────────────────────────
      await tx.$executeRaw`SELECT * FROM bills WHERE id = ${visit.bill.id} FOR UPDATE`

      const bill = visit.bill
      const now = new Date()
      const trimmedReason = reason?.trim()

      // ── STAGE 1: Consultation fee ─────────────────────────────────
      if (stage === 1) {
        if (visit.visit_type !== 'consultation') {
          throw httpError('Stage 1 waiver only applies to consultation visits', 400)
        }
        if (visit.status !== 'waiting') {
          throw httpError(`Cannot waive stage 1 — visit is already ${visit.status}`, 400)
        }
        if (bill.consultation_fee_status === 'paid') {
          throw httpError('Stage 1 is already paid!', 409)
        }
        if (bill.consultation_fee_status === 'waived') {
          throw httpError('Stage 1 is already waived!', 409)
        }
        const stage2Total = bill.lab_fee + bill.medication_fee + bill.procedure_fee
        await tx.bill.update({
          where: { id: bill.id },
          data: {
            consultation_fee_status: 'waived',
            consultation_fee_waived_by: currentUser?.username ?? 'unknown',
            consultation_fee_waive_reason: trimmedReason,
            consultation_fee_waived_at: now,
            total_amount: stage2Total
          },
        })

        await tx.visit.update({
          where: { id },
          data: { status: 'consultation_paid' },
        })

        return { stage: 1, visit, next_status: 'consultation_paid' }
      }

      // ── STAGE 2: Lab / medication / procedure fees ────────────────
      if (visit.status !== 'billing') {
        throw httpError(
          `Stage 2 waiver can only be done when visit status is 'billing'. Current: ${visit.status}`,
          400
        )
      }
      if (bill.stage2_status === 'paid') {
        throw httpError('Stage 2 is already paid', 409)
      }
      if (bill.stage2_status === 'waived') {
        throw httpError('Stage 2 is already waived', 409)
      }

      // Stage 1 must be resolved before stage 2 (for consultations)
      if (visit.visit_type === 'consultation' && bill.consultation_fee_status === 'pending') {
        throw httpError('Stage 1 must be paid or waived before stage 2 can be waived', 400)
      }

      const stage2Total = bill.lab_fee + bill.medication_fee + bill.procedure_fee

      // If stage 1 was also waived (or no consultation fee), overall is waived
      // If stage 1 was paid, overall stays paid (money did change hands)
      const overallStatus =
        (visit.visit_type !== 'consultation' || bill.consultation_fee_status === 'waived')
          ? 'waived'
          : 'paid'

      await tx.bill.update({
        where: { id: bill.id },
        data: {
          stage2_status: 'waived',
          stage2_waived_by: currentUser?.username ?? 'unknown',
          stage2_waive_reason: trimmedReason,
          stage2_waived_at: now,
          fee_status: overallStatus,
        },
      })

      await tx.visit.update({
        where: { id },
        data: { status: 'done' },
      })

      return { stage: 2, visit, next_status: 'done', waivedAmount: stage2Total }
    })

    const patientName = result.visit?.patient?.name ?? 'Unknown'

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: result.stage === 1 ? 'Waive Stage 1' : 'Waive Stage 2',
        description: result.stage === 1
          ? `Waived consultation fee for ${patientName} — reason: ${reason}`
          : `Waived stage 2 fees (${result.waivedAmount}) for ${patientName} — reason: ${reason}`,
        category: 'payment',
        entity: 'bill',
        entityId: result.visit.bill.id,
        ipAddress: ip,
      })

      if (result.stage === 1) {
        await createNotification({
          targetRoles: ['doctor'],
          type: NOTIFICATION_TYPES.VISIT_FORWARDED,
          visitId: id,
          title: 'Patient ready for consultation',
          message: `${patientName} is waiting for consultation.`,
          io,
        })
        io.to('doctor').emit('visit:new', {
          visit_id: id,
          patient_name: patientName,
        })
      }

      if (result.stage === 2) {
        // Notify admin that a visit was completed with waived fees
        await createNotification({
          targetRoles: ['admin', 'receptionist'],
          type: NOTIFICATION_TYPES.VISIT_FORWARDED, // or your own type
          visitId: id,
          title: 'Visit completed — fees waived',
          message: `${patientName}'s stage 2 fees (${result.waivedAmount}) were waived. Visit marked done.`,
          io,
        })
      }
    } catch (sideErr) {
      console.error('waivePayment post-commit side effect failed:', sideErr.message)
    }

    return res.json({
      success: true,
      message: result.stage === 1
        ? 'Consultation fee waived — patient forwarded to doctor'
        : `Stage 2 fees waived (${result.waivedAmount}) — visit marked done`,
    })

  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message })
    }
    console.error('waivePayment error:', error.message)
    return res.status(500).json({ error: 'Failed to waive payment' })
  }
}

module.exports.forwardToDoctor = (req, res) => updateVisitStatus(req, res, 'with_doctor')
module.exports.forwardToLab = (req, res) => updateVisitStatus(req, res, 'lab')
module.exports.forwardToBilling = (req, res) => updateVisitStatus(req, res, 'billing')
module.exports.markDone = (req, res) => updateVisitStatus(req, res, 'done')
module.exports.archiveVisit = (req, res) => updateVisitStatus(req, res, 'archived')