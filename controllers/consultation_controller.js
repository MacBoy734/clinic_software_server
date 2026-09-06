const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')
const { writeAuditLog, createNotification, NOTIFICATION_TYPES, recomputeMedicationFee, BILLABLE_ITEM_STATUSES } = require('../utils/helpers')
const pharmacy = require('./pharmacy_controller')

const MEDICATION = pharmacy.MEDICATION

const DOCTOR_ACTIONABLE_STATUSES = ['consultation_paid', 'with_doctor', 'lab', 'pharmacy']

function safeIO() {
  try { return getIO() } catch { return null }
}

function shapeVisit(v) {
  return {
    id: v.id,
    patient_id: v.patient_id,
    patient_name: v.patient?.name ?? null,
    patient_age: v.patient?.age ?? null,
    patient_age_unit: v.patient?.age_unit ?? 'years',
    patient_gender: v.patient?.gender ?? null,
    blood_group: v.patient?.blood_group ?? null,
    allergies: v.patient?.allergies ?? null,
    phone: v.patient?.phone ?? null,
    queue_number: v.queue_number,
    visit_type: v.visit_type,
    status: v.status,
    chief_complaint: v.chief_complaint ?? null,
    diagnosis: v.diagnosis ?? null,
    diagnosis_code: v.diagnosis_code ?? null,
    subjective: v.subjective ?? null,
    objective: v.objective ?? null,
    assessment: v.assessment ?? null,
    plan: v.plan ?? null,
    has_lab_results: v.has_lab_results,
    medication_verification: v.medication_verification,
    from_pharmacy: v.medication_verification,
    procedure_fee: v.bill?.procedure_fee ?? 0,
    consultation_fee: v.bill?.consultation_fee ?? 0,
    lab_fee: v.bill?.lab_fee ?? 0,
    medication_fee: v.bill?.medication_fee ?? 0,
    bill_total: v.bill?.total_amount ?? 0,
    arrived_at: v.arrived_at,
    temperature: v.vitals?.temperature ?? null,
    bp_systolic: v.vitals?.bp_systolic ?? null,
    bp_diastolic: v.vitals?.bp_diastolic ?? null,
    pulse: v.vitals?.pulse ?? null,
    respiratory_rate: v.vitals?.respiratory_rate ?? null,
    weight: v.vitals?.weight_kg ?? null,
    height: v.vitals?.height_cm ?? null,
    spo2: v.vitals?.spo2 ?? null,
    vitals_notes: v.vitals?.vitals_notes ?? null,
    doctor: v.doctor?.username ?? null,
  }
}

function shapeLabRequest(r) {
  return {
    id: r.id,
    urgency: r.urgency,
    ordered_by: r.ordered_by ?? null,
    ordered_at: r.requested_at,
    completed_at: r.completed_at ?? null,
    status: r.status,
    notes: r.notes ?? null,
    items: (r.items ?? []).map((it) => ({
      id: it.id,
      test_name: it.test_name,
      category: it.category ?? null,
      reference_range: it.reference_range ?? null,
      unit_cost: it.unit_cost,
      result: it.result ?? null,
      applied_ranges: it.applied_ranges ?? null,
      result_data: it.result_data ?? null,
      result_notes: it.result_notes ?? null,
      flagged: it.flagged ?? false,
      completed_at: it.completed_at ?? null,
      status: it.status,
      result_template: it.catalog?.result_template ?? null,
    })),
  }
}

function shapePrescription(p) {
  return {
    id: p.id,
    prescribed_by: p.prescribed_by ?? null,
    prescribed_at: p.created_at,
    status: p.status,
    notes: p.notes ?? null,
    verified_by: p.verified_by ?? null,
    verified_at: p.verified_at ?? null,
    returned_by: p.returned_by ?? null,
    returned_at: p.returned_at ?? null,
    return_reason: p.return_reason ?? null,
    patient_name: p.visit?.patient?.name ?? null,
    patient_age: p.visit?.patient?.age ?? null,
    patient_age_unit: p.visit?.patient?.age_unit ?? 'years',
    patient_gender: p.visit?.patient?.gender ?? null,
    items: (p.items ?? []).map((it) => ({
      id: it.id,
      medication: it.drug_name,
      dosage: it.dosage,
      frequency: it.frequency,
      duration: it.duration,
      quantity: it.quantity,
      unit_cost: it.unit_cost,
      line_total: it.unit_cost * it.quantity,
      status: it.status,
      form: it.form ?? null,
      product_id: it.product_id ?? null,
      drug_id: it.product_id ?? null,
      product_batch_id: it.product_batch_id ?? null,
      decline_reason: it.decline_reason ?? null,
      return_reason: it.return_reason ?? null,
      restock_reject_reason: it.restock_reject_reason ?? null,
      dispensed_at: it.dispensed_at ?? null,
      returned_by: it.returned_by ?? null,
      returned_at: it.returned_at ?? null,
      restocked_by: it.restocked_by ?? null,
      restocked_at: it.restocked_at ?? null,
      awaiting_restock: it.status === 'returned',
      billable: BILLABLE_ITEM_STATUSES.includes(it.status),
    })),
  }
}


// ─── Queue / visits ───────────────────────────────────────────────────────────

exports.getQueue = async (req, res) => {
  try {
    const visits = await prisma.visit.findMany({
      where: {
        visit_type: { notIn: ['direct_lab'] },
        status: { in: DOCTOR_ACTIONABLE_STATUSES },
      },
      include: {
        patient: true,
        vitals: true,
        bill: {
          select: {
            procedure_fee: true, consultation_fee: true,
            lab_fee: true, medication_fee: true,
          },
        },
        doctor: { select: { username: true } },
        lab_requests: { select: { status: true } },
      },
      orderBy: { arrived_at: 'asc' },
    })

    res.json({ visits: visits.map(shapeVisit) })
  } catch (err) {
    console.error('getQueue', err)
    res.status(500).json({ error: 'Failed to fetch queue' })
  }
}

exports.getVisit = async (req, res) => {
  try {
    const id = req.params.id   // already coerced to number by validate({ params })

    const visit = await prisma.visit.findUnique({
      where: { id },
      include: {
        patient: true,
        vitals: true,
        bill: {
          select: {
            procedure_fee: true, consultation_fee: true,
            lab_fee: true, medication_fee: true,
          },
        },
        doctor: { select: { username: true } },
      },
    })
    if (!visit) return res.status(404).json({ error: 'Visit not found' })
    if (!DOCTOR_ACTIONABLE_STATUSES.includes(visit.status)) {
      return res.json({
        locked: true,
        visit: {
          id: visit.id,
          patient_name: visit.patient?.name ?? null,
          status: visit.status,
          visit_type: visit.visit_type,
        },
      })
    }

    res.json({ locked: false, visit: shapeVisit(visit) })
  } catch (err) {
    console.error('getVisit', err)
    res.status(500).json({ error: 'Failed to fetch visit' })
  }
}

exports.getPatientDatabase = async (req, res) => {
  try {
    // req.query is already validated and coerced by the route middleware
    const {
      search, gender, age_group, visit_type, diagnosis_code,
      has_allergies, date_from, date_to,
    } = req.query

    const AND = []

    AND.push({
      OR: [
        { diagnosis: { not: null } },
        { status: { in: ['with_doctor', 'lab', 'pharmacy', 'billing', 'done', 'archived'] } },
      ],
    })

    AND.push(visit_type ? { visit_type } : { visit_type: { not: 'direct_lab' } })

    if (diagnosis_code) AND.push({ diagnosis_code })

    const patientWhere = {}
    if (gender) patientWhere.gender = gender
    if (has_allergies === '1') patientWhere.allergies = { not: null }
    if (Object.keys(patientWhere).length) AND.push({ patient: patientWhere })

    if (date_from || date_to) {
      const range = {}
      if (date_from) range.gte = new Date(date_from)
      if (date_to) {
        const end = new Date(date_to)
        end.setDate(end.getDate() + 1)
        range.lt = end
      }
      AND.push({ arrived_at: range })
    }

    if (search) {
      AND.push({
        OR: [
          { patient: { name: { contains: search, mode: 'insensitive' } } },
          { patient: { phone: { contains: search, mode: 'insensitive' } } },
          { diagnosis: { contains: search, mode: 'insensitive' } },
        ],
      })
    }

    const visits = await prisma.visit.findMany({
      where: { AND },
      include: {
        patient: true,
        vitals: true,
        bill: {
          include: {
            payments: {
              orderBy: { paid_at: 'asc' },
              select: { amount: true, method: true, reference: true, stage: true, paid_at: true },
            },
          },
        },
        doctor: { select: { username: true } },
      },
      orderBy: { arrived_at: 'desc' },
    })

    const AGE_RANGES = {
      under5: (a) => a < 5,
      over5: (a) => a >= 5,
      under18: (a) => a < 18,
      adult: (a) => a >= 18 && a < 65,
      senior: (a) => a >= 65,
    }
    const ageFilter = AGE_RANGES[age_group]

    const records = visits
      .map((v) => {
        const bill = v.bill
        const totalPaid = (bill?.payments ?? []).reduce((s, p) => s + p.amount, 0)
        return {
          visit_id: v.id,
          patient_id: v.patient_id,
          patient_name: v.patient.name,
          patient_gender: v.patient.gender,
          patient_age: v.patient.age ?? null,
          blood_group: v.patient.blood_group ?? null,
          allergies: v.patient.allergies ?? null,
          phone: v.patient.phone ?? null,
          visit_type: v.visit_type,
          status: v.status,
          diagnosis: v.diagnosis ?? null,
          diagnosis_code: v.diagnosis_code ?? null,
          doctor: v.doctor?.username ?? null,
          arrived_at: v.arrived_at,

          subjective: v.subjective ?? null,
          objective: v.objective ?? null,
          assessment: v.assessment ?? null,
          plan: v.plan ?? null,
          temperature: v.vitals?.temperature ?? null,
          bp_systolic: v.vitals?.bp_systolic ?? null,
          bp_diastolic: v.vitals?.bp_diastolic ?? null,
          pulse: v.vitals?.pulse ?? null,
          respiratory_rate: v.vitals?.respiratory_rate ?? null,
          weight: v.vitals?.weight_kg ?? null,
          height: v.vitals?.height_cm ?? null,
          spo2: v.vitals?.spo2 ?? null,
          from_pharmacy: v.medication_verification,

          consultation_fee: bill?.consultation_fee ?? 0,
          lab_fee: bill?.lab_fee ?? 0,
          medication_fee: bill?.medication_fee ?? 0,
          procedure_fee: bill?.procedure_fee ?? 0,
          paid_amount: totalPaid,
          payments: (bill?.payments ?? []).map((p) => ({
            amount: p.amount,
            method: p.method,
            reference: p.reference ?? null,
            stage: p.stage,
            paid_at: p.paid_at,
          })),
        }
      })
      .filter((r) => !ageFilter || (r.patient_age != null && ageFilter(r.patient_age)))

    const diagMap = new Map()
    for (const r of records) {
      if (!r.diagnosis_code) continue
      const entry = diagMap.get(r.diagnosis_code)
        || { code: r.diagnosis_code, label: r.diagnosis || r.diagnosis_code, count: 0 }
      entry.count += 1
      diagMap.set(r.diagnosis_code, entry)
    }
    const diagnoses = [...diagMap.values()].sort((a, b) => b.count - a.count)

    const unique = new Set(records.map((r) => r.patient_id)).size
    const stats = {
      total_records: records.length,
      unique_patients: unique,
      with_diagnosis: records.filter((r) => r.diagnosis).length,
      male: records.filter((r) => r.patient_gender === 'male').length,
      female: records.filter((r) => r.patient_gender === 'female').length,
      with_allergies: records.filter((r) => r.allergies).length,
    }

    res.json({ records, stats, diagnoses })
  } catch (err) {
    console.error('getPatientDatabase', err.message)
    res.status(500).json({ error: 'Failed to fetch patient database' })
  }
}

// ─── Catalogues the doctor reads ──────────────────────────────────────────────

exports.getLabCatalog = async (req, res) => {
  try {
    const tests = await prisma.labTestCatalog.findMany({
      where: { is_active: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, category: true, reference_range: true, unit_cost: true },
    })
    res.json({ tests })
  } catch (err) {
    console.error('getLabCatalog', err)
    res.status(500).json({ error: 'Failed to fetch lab catalog' })
  }
}


exports.getDrugs = async (req, res) => {
  try {
    const drugs = await prisma.product.findMany({
      where: {
        category: MEDICATION,
        is_active: true,
        current_stock: { gt: 0 },
      },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, generic_name: true, sub_category: true,
        form: true, strength: true, current_stock: true, unit: true,
        normal_price: true,
      },
    })

    const items = drugs.map((d) => ({
      id: d.id,
      name: d.name,
      generic_name: d.generic_name ?? '',
      category: d.sub_category ?? '',
      sub_category: d.sub_category ?? '',
      form: d.form ?? '',
      strength: d.strength ?? '',
      current_stock: d.current_stock,
      unit: d.unit,
      unit_price: d.normal_price,
    }))

    res.json({ items })
  } catch (err) {
    console.error('getDrugs', err.message)
    res.status(500).json({ error: 'Failed to fetch drugs' })
  }
}

exports.getDrugStock = async (req, res) => {
  try {
    const items = await prisma.product.findMany({
      where: { category: MEDICATION, is_active: true },
      orderBy: [{ name: 'asc' }],
    })

    res.json({
      items: items.map((d) => ({
        id: d.id,
        name: d.name,
        generic_name: d.generic_name ?? '',
        category: d.sub_category ?? '',
        sub_category: d.sub_category ?? '',
        product_category: d.category,
        strength: d.strength ?? '',
        unit: d.unit,
        current_stock: d.current_stock,
        reorder_level: d.reorder_level,
        expiry_date: d.expiry_date,
        batch_number: d.batch_number ?? null,
        pharmacy_normal_price: d.normal_price,
      })),
    })
  } catch (err) {
    console.error('getDrugStock', err.message)
    res.status(500).json({ error: 'Failed to fetch drug stock' })
  }
}

exports.getSupplies = async (req, res) => {
  try {
    const { q } = req.query

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

exports.createPharmacyOrder = pharmacy.createInternalOrder

exports.getDoctorOrders = async (req, res) => {
  try {
    const orders = await prisma.pharmacyOrder.findMany({
      where: { department: 'doctor' },
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
    console.error('getDoctorOrders', err.message)
    res.status(500).json({ error: 'Failed to fetch orders' })
  }
}

// ─── Labs ─────────────────────────────────────────────────────────────────────

exports.getLabRequests = async (req, res) => {
  try {
    const visitId = req.params.id  

    const requests = await prisma.labRequest.findMany({
      where: { visit_id: visitId },
      include: { items: { include: { catalog: { select: { result_template: true } } } } },
      orderBy: { requested_at: 'desc' },
    })
    res.json({ requests: requests.map(shapeLabRequest) })
  } catch (err) {
    console.error('getLabRequests', err.message)
    res.status(500).json({ error: 'Failed to fetch lab requests' })
  }
}

exports.orderLabTests = async (req, res) => {
  try {
    const visitId = req.params.id   // already coerced
    const { test_ids, urgency } = req.body   // already validated by validate({ body })
    const ids = [...new Set(test_ids)]
    const doctorName = req.user?.username ?? 'Doctor'

    const request = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        select: { id: true, status: true },
      })
      if (!visit) throw Object.assign(new Error('Visit not found'), { status: 404 })

      const catalog = await tx.labTestCatalog.findMany({
        where: { id: { in: ids }, is_active: true },
        select: { id: true, name: true, category: true, reference_range: true, unit_cost: true },
      })
      if (catalog.length !== ids.length) {
        throw Object.assign(
          new Error('One or more selected tests are invalid or inactive'),
          { status: 400 }
        )
      }

      const created = await tx.labRequest.create({
        data: {
          visit_id: visitId,
          urgency,
          ordered_by: doctorName,
          status: 'pending',
          items: {
            create: catalog.map((t) => ({
              catalog_id: t.id,
              test_name: t.name,
              category: t.category,
              reference_range: t.reference_range,
              unit_cost: t.unit_cost,
              status: 'pending',
            })),
          },
        },
        include: { items: { include: { catalog: { select: { result_template: true } } } } },
      })

      const allItems = await tx.labRequestItem.findMany({
        where: { lab_request: { visit_id: visitId } },
        select: { unit_cost: true },
      })
      const labFee = allItems.reduce((s, i) => s + i.unit_cost, 0)
      await tx.bill.upsert({
        where: { visit_id: visitId },
        create: { visit_id: visitId, lab_fee: labFee },
        update: { lab_fee: labFee },
      })

      if (visit.status === 'with_doctor') {
        await tx.visit.update({ where: { id: visitId }, data: { status: 'lab' } })
      }

      return created
    })

    const io = safeIO()
    try {
      await createNotification({
        targetRoles: ['lab_tech'],
        type: NOTIFICATION_TYPES.LAB_REQUEST_NEW,
        title: 'New lab tests',
        visitId,
        message: `New lab tests requested for visit #${visitId}`,
        io,
      })
      if (io) io.to('lab_tech').emit('visit:new')
    } catch (e) {
      console.error('orderLabTests side effect failed:', e.message)
    }

    res.json({ success: true, request: shapeLabRequest(request) })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('orderLabTests', err)
    res.status(500).json({ error: 'Failed to order lab tests' })
  }
}

// ─── Procedures ───────────────────────────────────────────────────────────────

exports.completeProcedure = async (req, res) => {
  const visitId = parseInt(req.params.id)
  const { price } = req.body
  const ip = req.ip ?? null
  const currentUser = req.user

  if (!Number.isInteger(visitId)) {
    return res.status(400).json({ error: 'Invalid visit id' })
  }

  const procedurePrice = Math.round(Number(price))
  if (!Number.isFinite(procedurePrice) || procedurePrice <= 0) {
    return res.status(400).json({ error: 'Procedure fee must be a positive whole number' })
  }
  if (procedurePrice > 999_999_999) {
    return res.status(400).json({ error: 'Fee exceeds maximum allowed amount' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        include: { bill: true, patient: { select: { name: true } } },
      })
      if (!visit) throw Object.assign(new Error('Visit not found'), { status: 404 })
      if (!visit.bill) throw Object.assign(new Error('Bill not found for this visit'), { status: 404 })

      if (!DOCTOR_ACTIONABLE_STATUSES.includes(visit.status)) {
        throw Object.assign(
          new Error(`Patient is at ${visit.status} and can no longer be updated from consultation.`),
          { status: 409 }
        )
      }

      // ROW LOCK: prevents two updates at the same time
      await tx.$executeRaw`SELECT * FROM bills WHERE id = ${visit.bill.id} FOR UPDATE`

      const freshBill = await tx.bill.findUnique({ where: { id: visit.bill.id } })
      const wasAlreadySet = freshBill.procedure_fee > 0
      const oldFee = freshBill.procedure_fee || 0

      const bill = await tx.bill.update({
        where: { id: freshBill.id },
        data: {
          procedure_fee: procedurePrice,
          total_amount:
            freshBill.consultation_fee +
            freshBill.lab_fee +
            freshBill.medication_fee +
            procedurePrice,
        },
      })

      return { bill, patientName: visit.patient?.name ?? 'patient', wasAlreadySet, oldFee }
    })

    // Side effects
    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: result.wasAlreadySet ? 'Procedure Fee Updated' : 'Procedure Fee Added',
        description: result.wasAlreadySet
          ? `Updated procedure fee from KES ${result.oldFee.toLocaleString()} to KES ${procedurePrice.toLocaleString()} on visit #${visitId}`
          : `Added procedure fee of KES ${procedurePrice.toLocaleString()} to visit #${visitId}`,
        category: 'bill',
        entity: 'bill',
        entityId: result.bill.id,
        ipAddress: ip,
      })
      const io = safeIO()
      if (io) {
        io.to('receptionist').emit('bill:updated', { visit_id: visitId, bill: result.bill })
      }
    } catch (sideErr) {
      console.error('completeProcedure side effect failed:', sideErr.message)
    }

    return res.json({
      success: true,
      message: result.wasAlreadySet
        ? `Procedure fee updated to KES ${procedurePrice.toLocaleString()}`
        : `Procedure fee of KES ${procedurePrice.toLocaleString()} added to bill`,
      bill: result.bill,
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('completeProcedure error:', err.message)
    return res.status(500).json({ error: 'Failed to save procedure fee' })
  }
}

// ─── Prescriptions ────────────────────────────────────────────────────────────

exports.getPrescriptions = async (req, res) => {
  try {
    const visitId = req.params.id

    const prescriptions = await prisma.prescription.findMany({
      where: { visit_id: visitId },
      include: { items: { orderBy: { id: 'asc' } }, visit: { include: { patient: true } } },
      orderBy: { created_at: 'desc' },
    })

    res.json({ prescriptions: prescriptions.map(shapePrescription) })
  } catch (err) {
    console.error('getPrescriptions', err.message)
    res.status(500).json({ error: 'Failed to fetch prescriptions' })
  }
}

exports.createPrescription = async (req, res) => {
  try {
    const visitId = req.params.id
    const { items = [], notes } = req.body
    const currentUser = req.user
    const ip = req.ip ?? null

    const lines = items.map((it) => ({
      productId: Number(it.product_id ?? it.drug_id),
      dosage: it.dosage ?? '',
      frequency: it.frequency ?? '',
      duration: it.duration ?? '',
      quantity: Number(it.quantity),
      unitCost: Number(it.unit_cost),
      form: it.form || 'oral',
    }))

    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        select: {
          id: true,
          status: true,
          lab_requests: { select: { status: true } },
          patient: { select: { name: true } },
        },
      })
      if (!visit) throw Object.assign(new Error('Visit not found'), { status: 404 })
      if (!DOCTOR_ACTIONABLE_STATUSES.includes(visit.status)) {
        throw Object.assign(
          new Error(`Patient is at ${visit.status} and can no longer be prescribed for.`),
          { status: 409 }
        )
      }

      const productIds = [...new Set(lines.map((l) => l.productId))]
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, category: true, is_active: true, current_stock: true },
      })
      const byId = new Map(products.map((p) => [p.id, p]))

      const unusable = productIds.filter((id) => {
        const p = byId.get(id)
        return !p || !p.is_active || p.category !== MEDICATION
      })
      if (unusable.length) {
        throw Object.assign(
          new Error(
            `Only active medications in stock can be prescribed — remove: ${unusable
              .map((id) => byId.get(id)?.name ?? `#${id}`)
              .join(', ')}`
          ),
          { status: 400 }
        )
      }

      // Aggregate per product: two lines of 5 against a stock of 6 each pass an
      // independent check, but the order draws 10 from one pool.
      const requested = new Map()
      for (const l of lines) {
        requested.set(l.productId, (requested.get(l.productId) ?? 0) + l.quantity)
      }
      for (const [productId, qty] of requested) {
        const p = byId.get(productId)
        if (qty > p.current_stock) {
          throw Object.assign(
            new Error(`Insufficient stock for ${p.name} — ${p.current_stock} available, ${qty} requested`),
            { status: 409 }
          )
        }
      }

      // product_batch_id stays null — the batch is a FEFO pick the pharmacist
      // makes at dispense.
      const created = await tx.prescription.create({
        data: {
          visit_id: visitId,
          prescribed_by: currentUser?.username ?? null,
          status: 'pending',
          notes: notes?.trim() || null,
          items: {
            create: lines.map((l) => ({
              product_id: l.productId,
              drug_name: byId.get(l.productId).name,
              dosage: l.dosage,
              frequency: l.frequency,
              duration: l.duration,
              quantity: l.quantity,
              unit_cost: l.unitCost,
              form: l.form,
              status: 'pending',
            })),
          },
        },
        include: { items: { orderBy: { id: 'asc' } }, visit: { include: { patient: true } } },
      })

      // No fee recompute: items are created `pending`, which is not billable.
      // The fee is written when the pharmacy dispenses.

      const labsOutstanding = visit.lab_requests.some(
        (r) => r.status === 'pending' || r.status === 'in_progress'
      )
      if (visit.status === 'with_doctor' && !labsOutstanding) {
        await tx.visit.update({ where: { id: visitId }, data: { status: 'pharmacy' } })
      }

      return { prescription: created, patientName: visit.patient?.name ?? 'patient' }
    })

    const shaped = shapePrescription(result.prescription)

    try {
      const io = safeIO()
      // Emit before the notification insert: a failing insert must not cost the
      // pharmacist their live update.
      if (io) io.to('pharmacist').emit('prescription:new', { visit_id: visitId, prescription: shaped })
      await createNotification({
        targetRoles: ['pharmacist'],
        type: NOTIFICATION_TYPES.RX_NEW,
        title: 'New prescription',
        visitId,
        message: `New prescription for ${result.patientName} (visit #${visitId})`,
        io,
      })
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'created_prescription',
        description: `Created prescription #${result.prescription.id} (${shaped.items.length} items) for visit #${visitId}`,
        category: 'prescription',
        entity: 'prescription',
        entityId: result.prescription.id,
        ipAddress: ip,
      })
    } catch (sideErr) {
      console.error('createPrescription side effect failed:', sideErr.message)
    }

    res.json({ success: true, prescription: shaped })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('createPrescription', err.message)
    res.status(500).json({ error: 'Failed to create prescription' })
  }
}

exports.patchVisit = async (req, res) => {
  try {
    const id = req.params.id
    const body = req.body

    const existing = await prisma.visit.findUnique({ where: { id }, select: { status: true, doctor_id: true } })
    if (!existing) return res.status(404).json({ error: 'Visit not found' })
    if (!DOCTOR_ACTIONABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({
        error: `Patient is at ${existing.status} and can no longer be updated from consultation.`,
      })
    }

    // ── Vitals fields ──────────────────────────────────────────────────────
    const VITAL_KEYS = [
      'temperature', 'bp_systolic', 'bp_diastolic', 'pulse',
      'respiratory_rate', 'weight', 'height', 'spo2', 'vitals_notes',
    ]
    const vitalsPayload = {}
    VITAL_KEYS.forEach((k) => {
      if (k in body) vitalsPayload[k] = body[k]
    })

    const vitalsMap = { weight: 'weight_kg', height: 'height_cm' }
    const prismaVitals = {}
    Object.entries(vitalsPayload).forEach(([k, v]) => {
      const col = vitalsMap[k] || k
      prismaVitals[col] = v
    })

    // ── Visit-level fields ────────────────────────────────────────────────
    const VISIT_KEYS = [
      'status', 'chief_complaint',
      'subjective', 'objective', 'assessment', 'plan',
      'diagnosis', 'diagnosis_code', 'notes',
      'has_lab_results', 'medication_verification',
    ]
    const visitPayload = {}
    VISIT_KEYS.forEach((k) => {
      if (k in body) visitPayload[k] = body[k]
    })

    if (body.status === 'with_doctor' && req.user?.id) {
      if (!existing.doctor_id) {
        visitPayload.doctor_id = req.user?.id
      }
    }

    // ── Business rule: cannot end consultation with pending work ──────────
    if (body.status === 'billing') {
      const pendingLabs = await prisma.labRequestItem.count({
        where: {
          lab_request: { visit_id: id },
          status: { in: ['pending', 'in_progress'] },
        },
      })
      const pendingRx = await prisma.prescriptionItem.count({
        where: {
          prescription: { visit_id: id },
          status: 'pending',
        },
      })
      if (pendingLabs > 0 || pendingRx > 0) {
        return res.status(409).json({
          error: 'Cannot end consultation with pending labs or medications',
        })
      }
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(prismaVitals).length > 0) {
        await tx.vitals.upsert({
          where: { visit_id: id },
          create: { visit_id: id, ...prismaVitals },
          update: prismaVitals,
        })
      }
      if (Object.keys(visitPayload).length > 0) {
        await tx.visit.update({ where: { id }, data: visitPayload })
      }
    })

    res.json({ success: true })
  } catch (err) {
    console.error('patchVisit', err.message)
    res.status(500).json({ error: 'Failed to update visit' })
  }
}

exports.returnPrescriptionItem = async (req, res) => {
  try {
    const prescriptionId = req.params.id
    const { item_id, reason } = req.body
    const currentUser = req.user
    const ip = req.ip ?? null
    const returnReason = reason.trim()

    const result = await prisma.$transaction(async (tx) => {
      // Lock first: two tabs would otherwise both read `issued`, both decrement
      // the bill, and queue two restocks.
      await tx.$executeRaw`SELECT id FROM prescription_items WHERE id = ${item_id} FOR UPDATE`

      const item = await tx.prescriptionItem.findFirst({
        where: { id: item_id, prescription_id: prescriptionId },
        include: { prescription: { select: { visit_id: true } } },
      })
      if (!item) throw Object.assign(new Error('Item not found'), { status: 404 })

      const visitId = item.prescription.visit_id
      const visit = await tx.visit.findUnique({ where: { id: visitId }, select: { status: true } })
      if (!DOCTOR_ACTIONABLE_STATUSES.includes(visit.status)) {
        throw Object.assign(
          new Error(`Patient is at ${visit.status} and can no longer be managed from consultation.`),
          { status: 409 }
        )
      }

      if (item.status !== 'issued') {
        throw Object.assign(
          new Error(`Only issued (dispensed) items can be returned. ${item.drug_name} is "${item.status}".`),
          { status: 409 }
        )
      }

      await tx.prescriptionItem.update({
        where: { id: item.id },
        data: {
          status: 'returned',
          return_reason: returnReason,
          returned_by: currentUser?.username ?? null,   // session, never req.body
          returned_at: new Date(),
          restock_reject_reason: null,
        },
      })
      await recomputeMedicationFee(tx, visitId)
      const remainingItems = await tx.prescriptionItem.count({
        where: {
          prescription_id: prescriptionId,
          status: { in: ['issued', 'pending'] },
        },
      })

      if (remainingItems === 0) {
        await tx.prescription.update({
          where: { id: prescriptionId },
          data: {
            status: 'returned',
            returned_by: currentUser?.username ?? null,
            returned_at: new Date(),
            return_reason: 'All items returned by doctor',
          },
        })
      }

      return { visitId, itemId: item.id, drugName: item.drug_name, quantity: item.quantity }
    })

    try {
      const io = safeIO()
      if (io) {
        io.to('pharmacist').emit('prescription:returned', {
          visit_id: result.visitId,
          prescription_id: prescriptionId,
          item_id: result.itemId,
          returned_by: currentUser?.username,
          reason: returnReason,
        })
      }
      await createNotification({
        targetRoles: ['pharmacist'],
        type: NOTIFICATION_TYPES.RX_RETURNED,
        title: 'Prescription item returned',
        visitId: result.visitId,
        message: `${result.drugName} ×${result.quantity} returned from visit #${result.visitId}. Reason: ${returnReason}`,
        io,
      })
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'return_prescription_item',
        description: `Returned ${result.drugName} ×${result.quantity} on visit #${result.visitId}: ${returnReason}`,
        category: 'prescription',
        entity: 'prescription_item',
        entityId: result.itemId,
        ipAddress: ip,
      })
    } catch (sideErr) {
      console.error('returnPrescriptionItem side effect failed:', sideErr.message)
    }

    res.json({ success: true })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('returnPrescriptionItem', err.message)
    res.status(500).json({ error: 'Failed to return item' })
  }
}

exports.returnPrescription = async (req, res) => {
  try {
    const prescriptionId = req.params.id
    const { reason } = req.body
    const currentUser = req.user
    const ip = req.ip ?? null
    const returnReason = reason.trim()

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id: prescriptionId },
        select: { id: true, status: true, visit_id: true },
      })
      if (!existing) throw Object.assign(new Error('Prescription not found'), { status: 404 })
      if (!['issued'].includes(existing.status)) {
        throw Object.assign(
          new Error(`Only an issued prescription can be returned. This one is "${existing.status}".`),
          { status: 409 }
        )
      }

      const visit = await tx.visit.findUnique({
        where: { id: existing.visit_id },
        select: { status: true },
      })
      if (!DOCTOR_ACTIONABLE_STATUSES.includes(visit.status)) {
        throw Object.assign(
          new Error(`Patient is at ${visit.status} and can no longer be managed from consultation.`),
          { status: 409 }
        )
      }

      await tx.$executeRaw`SELECT id FROM prescription_items WHERE prescription_id = ${prescriptionId} FOR UPDATE`

      const issuedCount = await tx.prescriptionItem.count({
        where: { prescription_id: prescriptionId, status: 'issued' },
      })
      if (issuedCount === 0) {
        throw Object.assign(
          new Error('No dispensed items left to return on this prescription.'),
          { status: 409 }
        )
      }

      const now = new Date()

      await tx.prescriptionItem.updateMany({
        where: { prescription_id: prescriptionId, status: 'issued' },
        data: {
          status: 'returned',
          return_reason: returnReason,
          returned_by: currentUser?.username ?? null,
          returned_at: now,
          restock_reject_reason: null,
        },
      })

      const prescription = await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
          status: 'returned',
          returned_by: currentUser?.username ?? null,
          returned_at: now,
          return_reason: returnReason,
        },
        include: { visit: { select: { patient: { select: { name: true } } } } },
      })

      await recomputeMedicationFee(tx, existing.visit_id)

      // Only pull the visit back when the doctor still holds it. Forcing
      // `pharmacy` unconditionally dragged visits out of billing and clobbered
      // an in-progress lab stage.
      if (visit.status === 'with_doctor') {
        await tx.visit.update({ where: { id: existing.visit_id }, data: { status: 'pharmacy' } })
      }

      return {
        visitId: existing.visit_id,
        itemCount: issuedCount,
        patientName: prescription.visit?.patient?.name ?? 'patient',
      }
    })

    try {
      const io = safeIO()
      if (io) {
        io.to('pharmacist').emit('prescription:returned', {
          visit_id: result.visitId,
          prescription_id: prescriptionId,
          returned_by: currentUser?.username,
          reason: returnReason,
        })
      }
      await createNotification({
        targetRoles: ['pharmacist'],
        type: NOTIFICATION_TYPES.RX_RETURNED,
        title: 'Prescription returned',
        visitId: result.visitId,
        message: `Prescription #${prescriptionId} (${result.itemCount} item${result.itemCount > 1 ? 's' : ''}) for ${result.patientName} was returned. Reason: ${returnReason}`,
        io,
      })
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'return_prescription',
        description: `Returned prescription #${prescriptionId} (${result.itemCount} items) on visit #${result.visitId}: ${returnReason}`,
        category: 'prescription',
        entity: 'prescription',
        entityId: prescriptionId,
        ipAddress: ip,
      })
    } catch (sideErr) {
      console.error('returnPrescription side effect failed:', sideErr.message)
    }

    res.json({ success: true })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('returnPrescription', err.message)
    res.status(500).json({ error: 'Failed to return prescription' })
  }
}
