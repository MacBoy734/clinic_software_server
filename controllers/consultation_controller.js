

const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')
const { writeAuditLog, createNotification, NOTIFICATION_TYPES } = require('../utils/helpers')
const { getSettings } =   require('../lib/settings')
const pharmacy = require('./pharmacy_controller')

const MEDICATION = pharmacy.MEDICATION

const DOCTOR_ACTIONABLE_STATUSES = ['consultation_paid', 'with_doctor', 'lab', 'pharmacy']

const FEE_EXCLUDED_ITEM_STATUSES = ['declined', 'returned', 'restocked', 'cancelled']


function safeIO() {
  try { return getIO() } catch { return null }
}

function shapeVisit(v) {
  return {
    id: v.id,
    patient_id: v.patient_id,
    patient_name: v.patient?.name ?? null,
    patient_age: v.patient?.age ?? null,
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
    // The consultation page reads this as "patient is back from pharmacy" —
    // set true by the dispense flow, cleared when the doctor ends the visit.
    from_pharmacy: v.medication_verification,
    procedure_name: v.procedure_name ?? null,
    procedure_type: v.procedure_type ?? null,
    procedure_notes: v.procedure_notes ?? null,
    procedure_done_by: v.procedure_done_by ?? null,
    procedure_fee: v.bill?.procedure_fee ?? 0,
    consultation_fee: v.bill?.consultation_fee ?? 0,
    lab_fee: v.bill?.lab_fee ?? 0,
    medication_fee: v.bill?.medication_fee ?? 0,
    bill_total:
      (v.bill?.consultation_fee ?? 0) +
      (v.bill?.lab_fee ?? 0) +
      (v.bill?.medication_fee ?? 0) +
      (v.bill?.procedure_fee ?? 0),
    arrived_at: v.arrived_at,
    // Vitals — flattened for the ConsultationTab useEffect sync
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
    return_reason: p.return_reason ?? null,
    patient_name: p.visit?.patient?.name ?? null,
    patient_age: p.visit?.patient?.age ?? null,
    patient_gender: p.visit?.patient?.gender ?? null,
    items: (p.items ?? []).map((it) => ({
      id: it.id,
      medication: it.drug_name,
      dosage: it.dosage,
      frequency: it.frequency,
      duration: it.duration,
      quantity: it.quantity,
      unit_cost: it.unit_cost,
      status: it.status,
      form: it.form ?? null,
      product_id: it.product_id ?? null,
      drug_id: it.product_id ?? null, // legacy alias — drop once clients migrate
      decline_reason: it.decline_reason ?? null,
      return_reason: it.return_reason ?? null,
      dispensed_at: it.dispensed_at ?? null,
    })),
  }
}

async function readMarkupPct(client = prisma) {
  const settings = await getSettings()
  return settings?.pharmacy_settings?.markup_pct ?? 0
}

async function recomputeMedicationFee(tx, visitId) {
  const items = await tx.prescriptionItem.findMany({
    where: {
      prescription: { visit_id: visitId },
      status: { notIn: FEE_EXCLUDED_ITEM_STATUSES },
    },
    select: { unit_cost: true, quantity: true },
  })
  const medFee = items.reduce((s, i) => s + i.unit_cost * i.quantity, 0)

  const bill = await tx.bill.upsert({
    where: { visit_id: visitId },
    create: { visit_id: visitId, medication_fee: medFee },
    update: { medication_fee: medFee },
  })

  // Keep the stored total in sync. (Schema debt: total_amount is derivable,
  // and Bill still has no line items.)
  return tx.bill.update({
    where: { id: bill.id },
    data: {
      total_amount: bill.consultation_fee + bill.lab_fee + medFee + bill.procedure_fee,
    },
  })
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
    const id = parseInt(req.params.id)
    if (!id) return res.status(400).json({ error: 'missing visit ID' })

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

    // date_to is inclusive (end of that day)
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

          procedure_name: v.procedure_name ?? null,
          procedure_type: v.procedure_type ?? null,
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

    // Diagnosis dropdown options, derived from the doctor's OWN data rather
    // than a hardcoded catalogue.
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

exports.getProcedures = async (req, res) => {
  try {
    const templates = await prisma.chargeTemplate.findMany({
      where: { is_active: true, category: { in: ['procedure', 'family_planning'] } },
      orderBy: { name: 'asc' },
    })
    const shape = (t) => ({
      id: t.id, name: t.name, price: t.amount, category: t.category, is_active: t.is_active,
    })
    res.json({
      procedures: templates.filter((t) => t.category === 'procedure').map(shape),
      familyPlanningMethods: templates.filter((t) => t.category === 'family_planning').map(shape),
    })
  } catch (err) {
    console.error('getProcedures', err)
    res.status(500).json({ error: 'Failed to fetch procedures' })
  }
}


exports.getDrugs = async (req, res) => {
  try {
    const [markupPct, drugs] = await Promise.all([
      readMarkupPct(),
      prisma.product.findMany({
        where: {
          category: MEDICATION,
          is_active: true,
          current_stock: { gt: 0 },
        },
        orderBy: { name: 'asc' },
      }),
    ])

    const factor = 1 + markupPct / 100

    const items = drugs.map((d) => ({
      id: d.id,
      name: d.name,
      generic_name: d.generic_name ?? '',
      category: d.sub_category ?? '',
      sub_category: d.sub_category ?? '',
      product_category: d.category,
      form: d.form ?? '',
      strength: d.strength ?? '',
      current_stock: d.current_stock,
      reorder_level: d.reorder_level,
      unit: d.unit,
      expiry_date: d.expiry_date,
      pharmacy_normal_price: d.normal_price,
      unit_price: Math.round(d.normal_price * factor),
    }))

    res.json({ items, markup_pct: markupPct })
  } catch (err) {
    console.error('getDrugs', err.message)
    res.status(500).json({ error: 'Failed to fetch drugs' })
  }
}


exports.getDrugStock = async (req, res) => {
  try {
    const [markupPct, items] = await Promise.all([
      readMarkupPct(),
      prisma.product.findMany({
        where: { category: MEDICATION, is_active: true },
        orderBy: [{ name: 'asc' }],
      }),
    ])
    const factor = 1 + markupPct / 100

    res.json({
      items: items.map((d) => ({
        id: d.id,
        name: d.name,
        generic_name: d.generic_name ?? '',
        // Same reasoning as getDrugs: the tab's chips filter on `category`,
        // which for a medication means its class.
        category: d.sub_category ?? '',
        sub_category: d.sub_category ?? '',
        product_category: d.category,
        form: d.form ?? '',
        strength: d.strength ?? '',
        unit: d.unit,
        current_stock: d.current_stock,
        reorder_level: d.reorder_level,
        expiry_date: d.expiry_date,
        batch_number: d.batch_number ?? null,
        pharmacy_normal_price: d.normal_price,
        // What a prescription would charge the patient.
        unit_price: Math.round(d.normal_price * factor),
      })),
      markup_pct: markupPct,
    })
  } catch (err) {
    console.error('getDrugStock', err.message)
    res.status(500).json({ error: 'Failed to fetch drug stock' })
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
    const visitId = parseInt(req.params.id)
    if (!visitId) return res.status(400).json({ error: 'missing visit ID' })

    const requests = await prisma.labRequest.findMany({
      where: { visit_id: visitId },
      include: { items: { include: { catalog: { select: { result_template: true } } } } },
      orderBy: { requested_at: 'desc' },
    })
    res.json({ requests: requests.map(shapeLabRequest) })
  } catch (err) {
    console.error('getLabRequests', err)
    res.status(500).json({ error: 'Failed to fetch lab requests' })
  }
}

exports.orderLabTests = async (req, res) => {
  try {
    const visitId = parseInt(req.params.id)
    if (!visitId) return res.status(400).json({ error: 'missing visit ID' })

    const { test_ids = [], urgency = 'routine' } = req.body
    const ids = [...new Set((test_ids || []).map(Number))]
    if (!ids.length) return res.status(400).json({ error: 'Select at least one test' })
    if (ids.some((n) => !Number.isInteger(n) || n < 1)) {
      return res.status(400).json({ error: 'Invalid test id' })
    }
    if (!['routine', 'urgent', 'stat'].includes(urgency)) {
      return res.status(400).json({ error: 'Invalid urgency' })
    }

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
  const { procedure_id, notes, doctor_name, price } = req.body
  const ip = req.ip ?? null
  const currentUser = req.user

  if (!visitId) return res.status(400).json({ error: 'missing visit ID' })
  if (!procedure_id) return res.status(400).json({ error: 'procedure_id is required' })
  const fee = Number(price)
  if (!Number.isFinite(fee) || fee < 0) {
    return res.status(400).json({ error: 'price must be a valid non-negative number' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        include: { bill: true, patient: { select: { name: true } } },
      })
      if (!visit) throw Object.assign(new Error('Visit not found'), { status: 404 })
      if (!DOCTOR_ACTIONABLE_STATUSES.includes(visit.status)) {
        throw Object.assign(
          new Error(`Patient is at ${visit.status} and can no longer be updated from consultation.`),
          { status: 409 }
        )
      }
      if (!visit.bill) throw Object.assign(new Error('Bill not found for this visit'), { status: 404 })

      const template = await tx.chargeTemplate.findFirst({
        where: {
          id: Number(procedure_id),
          is_active: true,
          category: { in: ['procedure', 'family_planning'] },
        },
      })
      if (!template) {
        throw Object.assign(new Error('Selected procedure is invalid or inactive'), { status: 400 })
      }

      await tx.visit.update({
        where: { id: visitId },
        data: {
          procedure_name: template.name,
          procedure_type: template.category,
          procedure_notes: notes?.trim() || null,
          procedure_done_by: doctor_name ?? currentUser?.username ?? 'Doctor',
        },
      })

      const bill = await tx.bill.update({
        where: { visit_id: visitId },
        data: {
          procedure_fee: fee,
          total_amount:
            visit.bill.consultation_fee +
            visit.bill.lab_fee +
            visit.bill.medication_fee +
            fee,
        },
      })

      return { bill, template }
    })

    try {
      const edited = fee !== result.template.amount
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'Procedure Added',
        description: `${result.template.name} (${result.template.category}) added to visit #${visitId} for ${fee}${edited ? ` (template price ${result.template.amount}, edited)` : ''}`,
        category: 'bill',
        entity: 'bill',
        entityId: result.bill.id,
        ipAddress: ip,
      })
      const io = safeIO()
      if (io) io.to('receptionist').emit('bill:updated', { visit_id: visitId, bill: result.bill })
    } catch (sideErr) {
      console.error('completeProcedure post-commit side effect failed:', sideErr.message)
    }

    return res.json({
      success: true,
      message: `${result.template.name} added to bill`,
      bill: result.bill,
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('completeProcedure error:', err.message)
    return res.status(500).json({ error: 'Failed to add procedure' })
  }
}

// ─── Prescriptions ────────────────────────────────────────────────────────────

exports.getPrescriptions = async (req, res) => {
  try {
    const visitId = parseInt(req.params.id)
    if (!visitId) return res.status(400).json({ error: 'missing visit ID' })

    const prescriptions = await prisma.prescription.findMany({
      where: { visit_id: visitId },
      include: { items: true, visit: { include: { patient: true } } },
      orderBy: { created_at: 'desc' },
    })
    res.json({ prescriptions: prescriptions.map(shapePrescription) })
  } catch (err) {
    console.error('getPrescriptions', err)
    res.status(500).json({ error: 'Failed to fetch prescriptions' })
  }
}


exports.createPrescription = async (req, res) => {
  try {
    const visitId = parseInt(req.params.id)
    const { items = [], notes } = req.body
    const ip = req.ip ?? null
    const currentUser = req.user

    if (!visitId) return res.status(400).json({ error: 'missing visit ID' })
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Add at least one medication' })
    }

    const norm = []
    for (const it of items) {
      const medication = typeof it.medication === 'string' ? it.medication.trim() : ''
      const rawId = it.product_id ?? it.drug_id
      const productId = rawId != null && rawId !== '' ? Number(rawId) : null
      const quantity = parseInt(it.quantity)

      if (!medication && productId == null) {
        return res.status(400).json({ error: 'Every line needs a medication' })
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Every line needs a positive whole-number quantity' })
      }

      norm.push({
        productId: Number.isInteger(productId) && productId > 0 ? productId : null,
        medication,
        dosage: it.dosage ?? '',
        frequency: it.frequency ?? '',
        duration: it.duration ?? '',
        quantity,
        form: it.form === 'injection' ? 'injection' : 'oral',
        clientCost: Math.max(0, parseInt(it.unit_cost) || 0),
      })
    }

    const result = await prisma.$transaction(async (tx) => {
      const visit = await tx.visit.findUnique({
        where: { id: visitId },
        select: {
          id: true, status: true,
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

      const ids = norm.filter((n) => n.productId != null).map((n) => n.productId)
      const products = ids.length
        ? await tx.product.findMany({ where: { id: { in: ids } } })
        : []
      const byId = new Map(products.map((p) => [p.id, p]))

      // The control. Not the picker.
      const blocked = norm
        .filter((n) => n.productId != null)
        .filter((n) => {
          const p = byId.get(n.productId)
          return !p || !p.is_active || p.category !== MEDICATION
        })
      if (blocked.length) {
        throw Object.assign(
          new Error(
            `Only medications can be prescribed — remove: ${blocked
              .map((n) => byId.get(n.productId)?.name ?? (n.medication || `#${n.productId}`))
              .join(', ')}`
          ),
          { status: 400 }
        )
      }

      const markupPct = await readMarkupPct(tx)
      const factor = 1 + markupPct / 100

      const created = await tx.prescription.create({
        data: {
          visit_id: visitId,
          prescribed_by: currentUser?.username,
          status: 'pending',
          notes: (typeof notes === 'string' && notes.trim()) || null,
          items: {
            create: norm.map((n) => {
              const p = n.productId != null ? byId.get(n.productId) : null
              return {
                product_id: n.productId,
                // Snapshot — the line still reads correctly after a rename.
                drug_name: p ? p.name : n.medication,
                dosage: n.dosage,
                frequency: n.frequency,
                duration: n.duration,
                quantity: n.quantity,
                // Server-resolved charge. Custom (unstocked) lines fall back
                // to what the doctor typed.
                unit_cost: p ? Math.round(p.normal_price * factor) : n.clientCost,
                form: p?.form === 'injection' ? 'injection' : n.form,
                status: 'pending',
              }
            }),
          },
        },
        include: { items: true, visit: { include: { patient: true } } },
      })

      await recomputeMedicationFee(tx, visitId)

      // Move to pharmacy if the consultation is done and no lab is pending.
      const hasActiveLab = visit.lab_requests.some(
        (r) => r.status === 'pending' || r.status === 'in_progress'
      )
      if (visit.status === 'with_doctor' && !hasActiveLab) {
        await tx.visit.update({ where: { id: visitId }, data: { status: 'pharmacy' } })
      }

      return { prescription: created, patientName: visit.patient?.name ?? 'patient' }
    })

    const io = safeIO()
    try {
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
        description: `Created prescription #${result.prescription.id} for visit #${visitId}`,
        category: 'prescription',
        entity: 'prescription',
        entityId: result.prescription.id,
        ipAddress: ip,
      })
      if (io) {
        io.to('pharmacist').emit('prescription:new', {
          prescription: shapePrescription(result.prescription),
        })
      }
    } catch (sideErr) {
      console.error('createPrescription post-commit side effect failed:', sideErr.message)
    }

    res.json({ success: true, prescription: shapePrescription(result.prescription) })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('createPrescription error: ', err.message)
    res.status(500).json({ error: 'Failed to create prescription' })
  }
}

exports.patchVisit = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const body = req.body

    const existing = await prisma.visit.findUnique({ where: { id }, select: { status: true } })
    if (!existing) return res.status(404).json({ error: 'Visit not found' })
    if (!DOCTOR_ACTIONABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({
        error: `Patient is at ${existing.status} and can no longer be updated from consultation.`,
      })
    }

    // ── Vitals fields — split off and upserted separately ──────────────────
    const VITAL_KEYS = [
      'temperature', 'bp_systolic', 'bp_diastolic', 'pulse',
      'respiratory_rate', 'weight', 'height', 'spo2', 'vitals_notes',
    ]
    const vitalsPayload = {}
    VITAL_KEYS.forEach((k) => {
      if (k in body) vitalsPayload[k] = body[k] === '' ? null : body[k]
    })

    const vitalsMap = { weight: 'weight_kg', height: 'height_cm' }
    const prismaVitals = {}
    Object.entries(vitalsPayload).forEach(([k, v]) => {
      const col = vitalsMap[k] || k
      prismaVitals[col] = v === null ? null : isNaN(Number(v)) ? v : Number(v)
    })

    // ── Visit-level fields ────────────────────────────────────────────────
    const VISIT_KEYS = [
      'status', 'doctor_id', 'chief_complaint',
      'subjective', 'objective', 'assessment', 'plan',
      'diagnosis', 'diagnosis_code', 'notes',
      'has_lab_results', 'medication_verification',
    ]
    const visitPayload = {}
    VISIT_KEYS.forEach((k) => {
      if (k in body) visitPayload[k] = body[k]
    })

    // The consultation page sends from_pharmacy:false on end-consultation.
    if ('from_pharmacy' in body) {
      visitPayload.medication_verification = !!body.from_pharmacy
    }

    if (body.status === 'with_doctor' && req.user?.id) {
      visitPayload.doctor_id = req.user.id
    }

    // One transaction, not Promise.all — a failed vitals upsert should not
    // leave the visit row already updated.
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
    const prescriptionId = parseInt(req.params.id)
    const { item_id, reason } = req.body
    const currentUser = req.user
    const ip = req.ip ?? null

    if (!item_id || !reason?.trim()) {
      return res.status(400).json({ error: 'item_id and reason are required' })
    }

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.prescriptionItem.findFirst({
        where: { id: parseInt(item_id), prescription_id: prescriptionId },
        include: { prescription: { select: { visit_id: true } } },
      })
      if (!item) throw Object.assign(new Error('Item not found'), { status: 404 })
      if (item.status !== 'issued') {
        throw Object.assign(
          new Error(`Only issued (dispensed) items can be returned. This item is "${item.status}".`),
          { status: 409 }
        )
      }

      await tx.prescriptionItem.update({
        where: { id: item.id },
        data: { status: 'returned', return_reason: reason.trim() },
      })

      await recomputeMedicationFee(tx, item.prescription.visit_id)

      return { visitId: item.prescription.visit_id, drugName: item.drug_name, itemId: item.id }
    })

    const io = safeIO()
    try {
      await createNotification({
        targetRoles: ['pharmacist'],
        type: NOTIFICATION_TYPES.RX_RETURNED,
        title: 'Prescription item returned',
        visitId: result.visitId,
        message: `${result.drugName} was returned from visit #${result.visitId}. Reason: ${reason.trim()}`,
        io,
      })
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'return_prescription_item',
        description: `Returned ${result.drugName} on visit #${result.visitId}: ${reason.trim()}`,
        category: 'prescription',
        entity: 'prescription_item',
        entityId: result.itemId,
        ipAddress: ip,
      })
      if (io) {
        io.to('pharmacist').emit('prescription:returned', {
          prescription_id: prescriptionId,
          item_id: result.itemId,
          returned_by: currentUser?.username,
          reason: reason.trim(),
        })
      }
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
    const id = parseInt(req.params.id)
    const { doctor_name, reason } = req.body
    const currentUser = req.user
    const ip = req.ip ?? null

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Prescription ID is required' })
    if (!reason?.trim()) return res.status(400).json({ error: 'reason is required' })

    const prescription = await prisma.$transaction(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id },
        select: { id: true, status: true, visit_id: true },
      })
      if (!existing) throw Object.assign(new Error('Prescription not found'), { status: 404 })
      if (!['issued', 'dispensed'].includes(existing.status)) {
        throw Object.assign(
          new Error(`Only a dispensed prescription can be returned. This one is "${existing.status}".`),
          { status: 409 }
        )
      }

      const p = await tx.prescription.update({
        where: { id },
        data: {
          status: 'returned',
          returned_by: doctor_name ?? currentUser?.username ?? 'Doctor',
          returned_at: new Date(),
          return_reason: reason.trim(),
        },
        include: { visit: { include: { patient: { select: { name: true } } } } },
      })

      await tx.prescriptionItem.updateMany({
        where: { prescription_id: id, status: 'issued' },
        data: { status: 'returned', return_reason: reason.trim() },
      })

      await recomputeMedicationFee(tx, existing.visit_id)

      await tx.visit.update({
        where: { id: existing.visit_id },
        data: { status: 'pharmacy' },
      })

      return p
    })

    const io = safeIO()
    try {
      await createNotification({
        targetRoles: ['pharmacist'],
        type: NOTIFICATION_TYPES.RX_RETURNED,
        title: 'Prescription returned',
        visitId: prescription.visit_id,
        message: `Prescription #${prescription.id} for ${prescription.visit?.patient?.name ?? 'patient'} was returned. Reason: ${reason.trim()}`,
        io,
      })
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'return_prescription',
        description: `Returned prescription #${prescription.id} on visit #${prescription.visit_id}: ${reason.trim()}`,
        category: 'prescription',
        entity: 'prescription',
        entityId: prescription.id,
        ipAddress: ip,
      })
      if (io) {
        io.to('pharmacist').emit('prescription:returned', {
          prescription_id: prescription.id,
          returned_by: currentUser?.username,
          reason: reason.trim(),
        })
      }
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


exports.confirmRestock = async (req, res) => {
  try {
    const itemId = parseInt(req.params.id)
    const currentUser = req.user
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'missing item ID' })

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.prescriptionItem.findUnique({
        where: { id: itemId },
        include: { prescription: { select: { visit_id: true } } },
      })
      if (!item) throw Object.assign(new Error('Item not found'), { status: 404 })
      if (item.status !== 'returned') {
        throw Object.assign(
          new Error(`Only returned items can be restocked. This item is "${item.status}".`),
          { status: 409 }
        )
      }

      await tx.prescriptionItem.update({
        where: { id: itemId },
        data: { status: 'restocked' },
      })

      let stockRestored = false
      if (item.product_id) {
        await pharmacy._giveStock(tx, {
          productId: item.product_id,
          quantity: item.quantity,
          reason: 'return_to_stock',
          refType: 'prescription_item',
          refId: item.id,
          staffId: currentUser?.id,
          note: `Returned from visit #${item.prescription.visit_id}`,
        })
        stockRestored = true
      }
      // No product_id → custom-typed medication; marked restocked with no
      // stock movement, because there is nothing to increment.

      return { stockRestored, drugName: item.drug_name, quantity: item.quantity }
    })

    try {
      await writeAuditLog({
        staffId: req.user?.id,
        user: req.user?.username,
        action: 'confirm_restock',
        description: `${result.drugName} ×${result.quantity} ${result.stockRestored ? 'returned to stock' : 'marked restocked (no linked product)'}`,
        category: 'stock',
        entity: 'prescription_item',
        entityId: itemId,
        ipAddress: req.ip ?? null,
      })
    } catch (e) { console.error('writeAuditLog failed:', e.message) }

    res.json({
      success: true,
      stock_restored: result.stockRestored,
      message: result.stockRestored
        ? `${result.drugName} restocked (+${result.quantity})`
        : `${result.drugName} marked restocked (no linked stock item)`,
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('confirmRestock', err)
    res.status(500).json({ error: 'Failed to confirm restock' })
  }
}


exports.verifyPrescription = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { doctor_name, notes } = req.body
    const currentUser = req.user
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Prescription ID is required' })

    const prescription = await prisma.$transaction(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id },
        select: { id: true, status: true, visit_id: true },
      })
      if (!existing) throw Object.assign(new Error('Prescription not found'), { status: 404 })
      if (existing.status === 'cancelled') {
        throw Object.assign(new Error('A cancelled prescription cannot be verified'), { status: 409 })
      }

      const p = await tx.prescription.update({
        where: { id },
        data: {
          status: 'issued',
          verified_by: doctor_name ?? currentUser?.username ?? 'Doctor',
          verified_at: new Date(),
          verify_notes: notes ?? null,
        },
      })

      await tx.prescriptionItem.updateMany({
        where: { prescription_id: id, status: 'pending' },
        data: { status: 'issued' },
      })

      await recomputeMedicationFee(tx, existing.visit_id)

      await tx.visit.update({
        where: { id: existing.visit_id },
        data: { medication_verification: false, status: 'billing' },
      })

      return p
    })

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'verify_prescription',
        description: `Verified prescription #${id} on visit #${prescription.visit_id}`,
        category: 'prescription',
        entity: 'prescription',
        entityId: id,
        ipAddress: req.ip ?? null,
      })
      const io = safeIO()
      if (io) {
        io.to('receptionist').emit('visit:status_changed', {
          visitId: prescription.visit_id,
          status: 'billing',
        })
      }
    } catch (e) { console.error('verifyPrescription side effect failed:', e.message) }

    res.json({ success: true })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('verifyPrescription', err)
    res.status(500).json({ error: 'Failed to verify prescription' })
  }
}