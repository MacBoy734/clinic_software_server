const bcrypt = require('bcryptjs')
const prisma = require('../lib/prisma')
const { writeAuditLog, getPeriodRange, todayRange, lastNDays, endOfDay, dayLabel, buildDayBuckets, resolveRange, parseDateRange, getPagination} = require('../utils/helpers')
const { getSettings, invalidateSettings, SETTINGS_ID } = require('../lib/settings')


function getPeriodStart(period) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (period === 'today') return d
  if (period === 'this_week') { d.setDate(d.getDate() - d.getDay()); return d }
  if (period === 'this_month') { d.setDate(1); return d }
  if (period === 'this_year') { d.setMonth(0, 1); return d }
  return d
}

function shapeExpense(e, domain) {
  return {
    id: e.id,
    description: e.description,
    amount: e.amount,
    category: e.category ?? null,
    domain,
    incurred_at: e.incurred_at,
    created_at: e.created_at,
    recorder: e.recorded_by_staff ? { username: e.recorded_by_staff.username } : null,
  }
}


const VISIT_INCLUDE = {
  doctor: { select: { username: true } },
  bill: true,
  lab_requests: {
    select: {
      id: true,
      status: true,
      notes: true,
      urgency: true,
      requested_at: true,
      completed_at: true,
      items: {
        select: { id: true, test_name: true, status: true, result: true, unit_cost: true },
      },
    },
  },
  prescriptions: {
    include: {
      items: {
        select: { id: true, drug_name: true, dosage: true, frequency: true, duration: true, quantity: true, unit_cost: true }
      }
    }
  },
}

function shapeReferral(r) {
  return {
    id: r.id,
    visit_id: r.visit_id,
    status: r.status,
    referrer_name: r.referrer_name,
    referrer_phone: r.referrer_phone ?? null,
    patient_name: r.visit?.patient?.name,
    test_ordered: r.test_ordered,
    notes: r.notes ?? null,
    referred_at: r.created_at,
    paid_at: r.paid_at ?? null,
    paid_by: r.paid_by ?? null,
    amount_paid: r.commission_amount ?? null,
  }
}

function flattenLabRequests(labRequests) {
  return labRequests.flatMap(lr =>
    lr.items.map(item => ({
      id: item.id,
      request_id: lr.id,
      test_name: item.test_name,
      status: item.status ?? lr.status,
      result: item.result ?? null,
      unit_cost: item.unit_cost ?? 0,
      urgency: lr.urgency ?? null,
      requested_at: lr.requested_at ?? null,
      completed_at: lr.completed_at ?? null,
    }))
  )
}

module.exports.getAdminOverview = async (req, res) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  try {
    const [
      visitsToday,
      paymentsToday,
      allBills,
      activeStaff,
      allProducts,
      allLabStock,
      recentPayments,
      recentVisits,
      recentExpenses,
    ] = await Promise.all([
      prisma.visit.findMany({
        where: { arrived_at: { gte: today } },
        select: {
          id: true, status: true, doctor_id: true,
          visit_type: true, arrived_at: true,
          patient: { select: { name: true } },
        },
      }),
      prisma.payment.findMany({
        where: { paid_at: { gte: today } },
        select: {
          amount: true, stage: true, paid_at: true,
          cashier: { select: { username: true } },
          bill: { select: { visit: { select: { patient: { select: { name: true } } } } } },
        },
      }),
      prisma.bill.findMany({
        where: { fee_status: 'pending' },
        select: {
          consultation_fee: true, consultation_fee_status: true,
          lab_fee: true, medication_fee: true, procedure_fee: true, stage2_status: true,
        },
      }),
      prisma.staff.findMany({
        where: { is_active: true, role: { not: 'admin' } },
        select: { id: true, username: true, role: true },
        orderBy: { role: 'asc' },
      }),
      prisma.product.findMany({
        select: { id: true, name: true, current_stock: true, reorder_level: true, unit: true },
      }),
      prisma.labStock.findMany({
        select: { id: true, name: true, current_stock: true, reorder_level: true, unit: true },
      }),
      prisma.payment.findMany({
        orderBy: { paid_at: 'desc' },
        take: 10,
        select: {
          id: true, amount: true, stage: true, paid_at: true,
          cashier: { select: { username: true } },
          bill: { select: { visit: { select: { patient: { select: { name: true } } } } } },
        },
      }),
      prisma.visit.findMany({
        orderBy: { arrived_at: 'desc' },
        take: 10,
        select: { id: true, arrived_at: true, visit_type: true, patient: { select: { name: true } } },
      }),
      prisma.clinicExpense.findMany({
        orderBy: { created_at: 'desc' },
        take: 5,
        select: { id: true, description: true, amount: true, created_at: true, recorded_by_staff: { select: { username: true } } },
      }),
    ])

    const pipeline = {
      waiting: visitsToday.filter(v => v.status === 'waiting').length,
      consultation_paid: visitsToday.filter(v => v.status === 'consultation_paid').length,
      with_doctor: visitsToday.filter(v => v.status === 'with_doctor').length,
      lab: visitsToday.filter(v => v.status === 'lab').length,
      pharmacy: visitsToday.filter(v => v.status === 'pharmacy').length,
      billing: visitsToday.filter(v => v.status === 'billing').length,
      done: visitsToday.filter(v => v.status === 'done').length,
    }

    const stage1 = paymentsToday.filter(p => p.stage === 1).reduce((s, p) => s + p.amount, 0)
    const stage2 = paymentsToday.filter(p => p.stage === 2).reduce((s, p) => s + p.amount, 0)

    const pendingBills = allBills.filter(b => b.consultation_fee_status === 'pending' || b.stage2_status === 'pending')
    const pendingAmount = pendingBills.reduce((sum, b) => {
      let owed = 0
      if (b.consultation_fee_status === 'pending') owed += b.consultation_fee
      if (b.stage2_status === 'pending') owed += b.lab_fee + b.medication_fee + b.procedure_fee
      return sum + owed
    }, 0)

    const activeVisitsByDoctor = {}
    visitsToday.filter(v => v.status === 'with_doctor' && v.doctor_id)
      .forEach(v => { activeVisitsByDoctor[v.doctor_id] = (activeVisitsByDoctor[v.doctor_id] || 0) + 1 })

    const staffOnDuty = activeStaff.map(s => ({
      id: s.id, username: s.username, role: s.role,
      active_visits: activeVisitsByDoctor[s.id] || 0,
    }))

    const lowDrugs = allProducts
      .filter(d => d.current_stock <= d.reorder_level)
      .map(d => ({ ...d, alert: d.current_stock === 0 ? 'out_of_stock' : 'low_stock' }))

    const lowReagents = allLabStock
      .filter(r => r.current_stock <= r.reorder_level)
      .map(r => ({ ...r, alert: r.current_stock === 0 ? 'out_of_stock' : 'low_stock' }))

    const activityEvents = []

    recentPayments.forEach(p => {
      const patientName = p.bill?.visit?.patient?.name ?? 'Unknown patient'
      activityEvents.push({
        id: `pay-${p.id}`,
        category: 'payment',
        description: `${patientName} paid KES ${p.amount.toLocaleString()} — ${p.stage === 1 ? 'consultation fee' : 'final bill'}`,
        user: p.cashier?.username ?? 'Cashier',
        timestamp: p.paid_at,
      })
    })

    recentVisits.forEach(v => {
      activityEvents.push({
        id: `visit-${v.id}`,
        category: 'patient',
        description: `${v.patient?.name ?? 'Patient'} registered — ${v.visit_type.replace(/_/g, ' ')}`,
        user: 'Reception',
        timestamp: v.arrived_at,
      })
    })

    recentExpenses.forEach(e => {
      activityEvents.push({
        id: `exp-${e.id}`,
        category: 'expense',
        description: `Expense: ${e.description} — KES ${e.amount.toLocaleString()}`,
        user: e.recorded_by_staff?.username ?? 'Staff',
        timestamp: e.created_at,
      })
    })

    const recentActivity = activityEvents
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 20)

    return res.json({
      stats: {
        patients_today: visitsToday.length,
        revenue_today: stage1 + stage2,
        stage1_collected: stage1,
        stage2_collected: stage2,
        pending_payments: pendingBills.length,
        pending_amount: pendingAmount,
        staff_on_duty: staffOnDuty.length,
      },
      pipeline,
      staff_on_duty: staffOnDuty,
      recent_activity: recentActivity,
      low_stock: { drugs: lowDrugs, reagents: lowReagents },
    })

  } catch (err) {
    console.error('getAdminOverview error:', err.message)
    return res.status(500).json({ error: 'Failed to load overview' })
  }
}
module.exports.getRevenueWeek = async (req, res) => {
  try {
    const days = lastNDays(7)
    const start = days[0]
    const end = new Date()
    end.setHours(23, 59, 59, 999)

    const [payments, expenses] = await Promise.all([
      prisma.payment.findMany({
        where: { paid_at: { gte: start, lte: end } },
        select: { amount: true, paid_at: true },
      }),
      prisma.clinicExpense.findMany({
        where: { incurred_at: { gte: start, lte: end } },
        select: { amount: true, incurred_at: true },
      }),
    ])

    const data = days.map((day) => {
      const dayStart = new Date(day)
      const dayEnd = new Date(day)
      dayEnd.setHours(23, 59, 59, 999)

      const revenue = payments
        .filter(p => new Date(p.paid_at) >= dayStart && new Date(p.paid_at) <= dayEnd)
        .reduce((s, p) => s + p.amount, 0)

      const expense = expenses
        .filter(e => new Date(e.incurred_at) >= dayStart && new Date(e.incurred_at) <= dayEnd)
        .reduce((s, e) => s + e.amount, 0)

      return { day: dayLabel(day), revenue, expenses: expense }
    })

    return res.json({ data })
  } catch (err) {
    console.error('getRevenueWeek', err)
    return res.status(500).json({ error: 'Failed to fetch revenue data' })
  }
}
module.exports.getRevenueReport = async (req, res) => {
  try {
    const period = req.query.period || 'this_month'
    const range = getPeriodRange(period)

    const payments = await prisma.payment.findMany({
      where: { paid_at: range },
      select: {
        id: true, amount: true, method: true, stage: true, paid_at: true,
        bill: { select: { visit: { select: { visit_type: true } } } },
      },
    })

    const otcSales = await prisma.otcSale.findMany({
      where: { sold_at: range },
      select: { id: true, total: true, payment_method: true, sold_at: true },
    })

    const [clinicExpenses, pharmacyExpenses] = await Promise.all([
      prisma.clinicExpense.findMany({
        where: { incurred_at: range },
        select: { amount: true, incurred_at: true, category: true },
      }),
      prisma.pharmacyExpense.findMany({
        where: { incurred_at: range },
        select: { amount: true, incurred_at: true, category: true },
      }),
    ])

    const clinic_revenue = payments.reduce((s, p) => s + p.amount, 0)
    const pharmacy_revenue = otcSales.reduce((s, s2) => s + s2.total, 0)
    const clinic_expenses = clinicExpenses.reduce((s, e) => s + e.amount, 0)
    const pharmacy_expenses = pharmacyExpenses.reduce((s, e) => s + e.amount, 0)
    const total_revenue = clinic_revenue + pharmacy_revenue
    const total_expenses = clinic_expenses + pharmacy_expenses
    const net_income = total_revenue - total_expenses

    const by_method = { cash: 0, mpesa: 0, insurance: 0, other: 0 }
    payments.forEach(p => {
      const m = p.method || 'other'
      by_method[m] = (by_method[m] || 0) + p.amount
    })
    otcSales.forEach(s => {
      const m = s.payment_method || 'other'
      by_method[m] = (by_method[m] || 0) + s.total
    })

    const by_visit_type = {}
    payments.forEach(p => {
      const vt = p.bill?.visit?.visit_type || 'unknown'
      by_visit_type[vt] = (by_visit_type[vt] || 0) + p.amount
    })
    if (pharmacy_revenue > 0) by_visit_type['otc_sale'] = pharmacy_revenue

    const chartDays = lastNDays(30)
    const chart_data = chartDays.map(day => {
      const dayEnd = endOfDay(day)

      const clinic_rev = payments
        .filter(p => new Date(p.paid_at) >= day && new Date(p.paid_at) <= dayEnd)
        .reduce((s, p) => s + p.amount, 0)

      const pharm_rev = otcSales
        .filter(s => new Date(s.sold_at) >= day && new Date(s.sold_at) <= dayEnd)
        .reduce((s, sale) => s + sale.total, 0)

      const clinic_exp = clinicExpenses
        .filter(e => new Date(e.incurred_at) >= day && new Date(e.incurred_at) <= dayEnd)
        .reduce((s, e) => s + e.amount, 0)

      const pharm_exp = pharmacyExpenses
        .filter(e => new Date(e.incurred_at) >= day && new Date(e.incurred_at) <= dayEnd)
        .reduce((s, e) => s + e.amount, 0)

      return {
        day: dayLabel(day),
        date: day.toISOString().slice(0, 10),
        clinic_revenue: clinic_rev,
        pharmacy_revenue: pharm_rev,
        total_revenue: clinic_rev + pharm_rev,
        expenses: clinic_exp + pharm_exp,
        net: (clinic_rev + pharm_rev) - (clinic_exp + pharm_exp),
      }
    })

    const stage1 = payments.filter(p => p.stage === 1).reduce((s, p) => s + p.amount, 0)
    const stage2 = payments.filter(p => p.stage === 2).reduce((s, p) => s + p.amount, 0)

    const expense_by_category = {}
      ;[...clinicExpenses, ...pharmacyExpenses].forEach(e => {
        const cat = e.category || 'uncategorised'
        expense_by_category[cat] = (expense_by_category[cat] || 0) + e.amount
      })

    return res.json({
      period,
      summary: {
        clinic_revenue,
        pharmacy_revenue,
        total_revenue,
        clinic_expenses,
        pharmacy_expenses,
        total_expenses,
        net_income,
        stage1_collected: stage1,
        stage2_collected: stage2,
        payment_count: payments.length,
        otc_sale_count: otcSales.length,
        expense_count: clinicExpenses.length + pharmacyExpenses.length,
      },
      by_method,
      by_visit_type,
      expense_by_category,
      chart_data,
    })
  } catch (err) {
    console.error('[admin] getRevenueReport:', err.message)
    return res.status(500).json({ error: 'Failed to fetch revenue report' })
  }
}
module.exports.getLabReport = async (req, res) => {
  try {
    const { start, end, days } = resolveRange(req.query)
    const where = { requested_at: { gte: start, lte: end } }
 
    const [labRequests, items] = await Promise.all([
      prisma.labRequest.findMany({
        where,
        select: { id: true, requested_at: true, completed_at: true },
      }),
      prisma.labRequestItem.findMany({
        where: { lab_request: where },
        select: { test_name: true },
      }),
    ])
 
    const total = labRequests.length
 
    // ── by_day (grouped by LabRequest.requested_at) ────────────────────────
    const dayBuckets = buildDayBuckets(start, days)
    const bucketByKey = Object.fromEntries(dayBuckets.map((b) => [b.key, b]))
    for (const lr of labRequests) {
      const key = new Date(lr.requested_at).toDateString()
      if (bucketByKey[key]) bucketByKey[key].count++
    }
    const by_day = dayBuckets.map(({ day, count }) => ({ day, count }))
 
    // ── avg_turnaround_hours (only requests completed within the range) ───
    const completed = labRequests.filter((lr) => lr.completed_at)
    const avg_turnaround_hours =
      completed.length > 0
        ? Math.round(
            (completed.reduce(
              (sum, lr) =>
                sum + (new Date(lr.completed_at) - new Date(lr.requested_at)),
              0
            ) /
              completed.length /
              (1000 * 60 * 60)) *
              10
          ) / 10
        : 0
 
    // ── top_tests / most_ordered (grouped by LabRequestItem.test_name) ─────
    const testCounts = items.reduce((acc, item) => {
      acc[item.test_name] = (acc[item.test_name] || 0) + 1
      return acc
    }, {})
    const top_tests = Object.entries(testCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
    const most_ordered = top_tests[0]?.name ?? '—'
 
    return res.json({
      stats: { total },
      by_day,
      top_tests,
      avg_turnaround_hours,
      most_ordered,
    })
  } catch (err) {
    console.error('[admin] getLabReport:', err.message)
    if (err.message === 'Invalid custom date range') {
      return res.status(400).json({ error: 'Invalid start/end date' })
    }
    return res.status(500).json({ error: 'Failed to fetch lab report' })
  }
}

module.exports.getAdminVisitsReport = async (req, res) => {
  try {
    const DAYS = 7
    const today = new Date()
    today.setHours(0, 0, 0, 0)
 
    const start = new Date(today)
    start.setDate(start.getDate() - (DAYS - 1)) 
 
    const end = new Date(today)
    end.setHours(23, 59, 59, 999)
 
    const where = { arrived_at: { gte: start, lte: end } }
 
    const [visits, byTypeGroups] = await Promise.all([
      prisma.visit.findMany({
        where,
        select: { id: true, status: true, visit_type: true, arrived_at: true },
      }),
      prisma.visit.groupBy({
        by: ['visit_type'],
        where,
        _count: { _all: true },
      }),
    ])
 
    const total_visits = visits.length
 
    // ── by_visit_type ──────────────────────────────────────────────────────
    const by_visit_type = byTypeGroups.reduce((acc, g) => {
      acc[g.visit_type] = g._count._all
      return acc
    }, {})
 
    // ── most_common_type ───────────────────────────────────────────────────
    const most_common_type = byTypeGroups
      .slice()
      .sort((a, b) => b._count._all - a._count._all)[0]?.visit_type ?? '—'
 
    // ── by_day (fixed 7-day window, oldest -> newest) ──────────────────────
    const dayBuckets = []
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      dayBuckets.push({
        key: d.toDateString(),
        day: d.toLocaleDateString('en-US', { weekday: 'short' }),
        count: 0,
      })
    }
    const bucketByKey = Object.fromEntries(dayBuckets.map((b) => [b.key, b]))
    for (const v of visits) {
      const key = new Date(v.arrived_at).toDateString()
      if (bucketByKey[key]) bucketByKey[key].count++
    }
    const by_day = dayBuckets.map(({ day, count }) => ({ day, count }))
 
    // ── avg_per_day ─────────────────────────────────────────────────────────
    const avg_per_day = Math.round(total_visits / DAYS)
 
    // ── completion_rate ──────────────────────────────────────────────────────
    const completedCount = visits.filter(
      (v) => v.status === 'done' || v.status === 'archived'
    ).length
    const completion_rate =
      total_visits > 0 ? Math.round((completedCount / total_visits) * 100) : 0
 
    return res.json({
      stats: {
        total_visits,
        avg_per_day,
        most_common_type,
        completion_rate,
      },
      by_day,
      by_visit_type,
    })
  } catch (err) {
    console.error('[admin] getAdminStats:', err.message)
    return res.status(500).json({ error: 'Failed to fetch admin stats' })
  }
}

module.exports.getPharmacyReport = async (req, res) => {
  try {
    const { start, end, days } = resolveRange(req.query)
 
    const [dispensedPrescriptions, otcSales, expenseAgg] = await Promise.all([
      // "Dispensed" = the prescription itself was handed out to the patient
      prisma.prescription.findMany({
        where: { dispensed_at: { gte: start, lte: end } },
        select: {
          id: true,
          dispensed_at: true,
          items: {
            select: { drug_name: true, quantity: true, status: true },
          },
        },
      }),
      prisma.otcSale.findMany({
        where: { sold_at: { gte: start, lte: end } },
        select: {
          id: true,
          sold_at: true,
          items: { select: { name: true, quantity: true } },
        },
      }),
      prisma.pharmacyExpense.aggregate({
        where: { incurred_at: { gte: start, lte: end } },
        _sum: { amount: true },
      }),
    ])
 
    const dispensed_total = dispensedPrescriptions.length
    const otc_total = otcSales.length
    const expenses_total = expenseAgg._sum.amount ?? 0
 
    // ── by_day: dispensed (by Prescription.dispensed_at) + otc (by OtcSale.sold_at)
    const dayBuckets = buildDayBuckets(start, days).map((b) => ({
      ...b,
      dispensed: 0,
      otc: 0,
    }))
    const bucketByKey = Object.fromEntries(dayBuckets.map((b) => [b.key, b]))
 
    for (const rx of dispensedPrescriptions) {
      const key = new Date(rx.dispensed_at).toDateString()
      if (bucketByKey[key]) bucketByKey[key].dispensed++
    }
    for (const sale of otcSales) {
      const key = new Date(sale.sold_at).toDateString()
      if (bucketByKey[key]) bucketByKey[key].otc++
    }
    const by_day = dayBuckets.map(({ day, dispensed, otc }) => ({
      day,
      dispensed,
      otc,
    }))
 
    // ── top_drugs: merge quantities from issued prescription items + OTC sale items
    const drugCounts = {}
 
    for (const rx of dispensedPrescriptions) {
      for (const item of rx.items) {
        if (item.status !== 'issued') continue // skip declined/returned/pending lines
        drugCounts[item.drug_name] =
          (drugCounts[item.drug_name] || 0) + (item.quantity || 0)
      }
    }
    for (const sale of otcSales) {
      for (const item of sale.items) {
        drugCounts[item.name] = (drugCounts[item.name] || 0) + (item.quantity || 0)
      }
    }
 
    const top_drugs = Object.entries(drugCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
 
    return res.json({
      stats: { dispensed_total, otc_total, expenses_total },
      by_day,
      top_drugs,
    })
  } catch (err) {
    console.error('[admin] getPharmacyReport:', err.message)
    if (err.message === 'Invalid custom date range') {
      return res.status(400).json({ error: 'Invalid start/end date' })
    }
    return res.status(500).json({ error: 'Failed to fetch pharmacy report' })
  }
}

module.exports.getPatients = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(100, parseInt(req.query.limit) || 20)
    const skip = (page - 1) * limit
    const period = req.query.period || 'this_month'
    const periodStart = getPeriodStart(period)

    const visit_type = req.query.visit_type
    const fee_status = req.query.fee_status
    const gender = req.query.gender
    const search = (req.query.search || '').trim()

    // 1. Find all visits in the period (filtered by visit_type)
    const visitWhere = { arrived_at: { gte: periodStart } }
    if (visit_type && visit_type !== 'all') visitWhere.visit_type = visit_type

    const matchingVisits = await prisma.visit.findMany({
      where: visitWhere,
      select: {
        id: true, patient_id: true, arrived_at: true,
        visit_type: true, diagnosis: true,
      },
      orderBy: { arrived_at: 'desc' },
    })

    const patientIdsWithVisits = [...new Set(matchingVisits.map(v => v.patient_id))]

    // 2. Filter patients by gender / search
    const patientWhere = { id: { in: patientIdsWithVisits } }
    if (gender && gender !== 'all') patientWhere.gender = gender
    if (search) {
      patientWhere.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { national_id: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [patients, total] = await Promise.all([
      prisma.patient.findMany({
        where: patientWhere,
        skip,
        take: limit,
        orderBy: { updated_at: 'desc' },
        select: {
          id: true, name: true, age: true, gender: true,
          phone: true, national_id: true, blood_group: true, allergies: true,
        },
      }),
      prisma.patient.count({ where: patientWhere }),
    ])

    // 3. Get all bills for these visits in ONE query
    const visitIds = matchingVisits.map(v => v.id)
    const bills = await prisma.bill.findMany({
      where: { visit_id: { in: visitIds } },
      select: { visit_id: true, total_amount: true, fee_status: true },
    })
    const billMap = new Map(bills.map(b => [b.visit_id, b]))

    // 4. Build last-visit map & bill aggregates per patient
    const lastVisitMap = new Map()
    const billAgg = {}
    for (const v of matchingVisits) {
      if (!lastVisitMap.has(v.patient_id)) lastVisitMap.set(v.patient_id, v)
      const b = billMap.get(v.id)
      if (!b) continue
      if (!billAgg[v.patient_id]) billAgg[v.patient_id] = { total: 0, unpaid: 0 }
      billAgg[v.patient_id].total += b.total_amount || 0
      if (b.fee_status === 'pending') billAgg[v.patient_id].unpaid += b.total_amount || 0
    }

    // 5. Shape
    let shaped = patients.map(p => {
      const last = lastVisitMap.get(p.id)
      const agg = billAgg[p.id] || { total: 0, unpaid: 0 }
      const visitCount = matchingVisits.filter(v => v.patient_id === p.id).length
      return {
        id: p.id,
        name: p.name,
        age: p.age,
        gender: p.gender,
        phone: p.phone,
        national_id: p.national_id,
        blood_group: p.blood_group,
        allergies: p.allergies,
        total_visits: visitCount,
        last_visit_date: last?.arrived_at ?? null,
        last_visit_type: last?.visit_type ?? null,
        last_diagnosis: last?.diagnosis ?? null,
        total_billed: agg.total,
        unpaid_balance: agg.unpaid,
      }
    })

    // 6. Apply fee_status filter (must happen after aggregation)
    if (fee_status && fee_status !== 'all') {
      shaped = shaped.filter(p => {
        if (fee_status === 'paid') return p.unpaid_balance === 0 && p.total_billed > 0
        if (fee_status === 'pending') return p.unpaid_balance > 0
        if (fee_status === 'waived') return false // track separately if needed
        return true
      })
    }

    return res.json({ patients: shaped, total, page, limit })
  } catch (err) {
    console.error('getPatients error:', err)
    return res.status(500).json({ error: 'Failed to fetch patients' })
  }
}

module.exports.getPatientStats = async (req, res) => {
  const { period = 'this_month' } = req.query
  const periodStart = getPeriodStart(period)

  try {
    const [totalPatients, billAgg, topDiagnosis, pendingAgg] = await Promise.all([
      prisma.patient.count({
        where: { visits: { some: { arrived_at: { gte: periodStart } } } },
      }),
      prisma.bill.aggregate({
        where: { visit: { arrived_at: { gte: periodStart } } },
        _sum: { total_amount: true },
      }),
      prisma.visit.groupBy({
        by: ['diagnosis'],
        where: { arrived_at: { gte: periodStart }, diagnosis: { not: null } },
        _count: { diagnosis: true },
        orderBy: { _count: { diagnosis: 'desc' } },
        take: 1,
      }),
      prisma.bill.aggregate({
        where: { visit: { arrived_at: { gte: periodStart } }, fee_status: 'pending' },
        _sum: { total_amount: true },
      }),
    ])

    return res.json({
      total_patients: totalPatients,
      total_billed: billAgg._sum.total_amount ?? 0,
      unpaid_balance: pendingAgg._sum.total_amount ?? 0,
      top_diagnosis: topDiagnosis[0]?.diagnosis ?? null,
    })
  } catch (err) {
    console.error('getPatientStats:', err)
    return res.status(500).json({ error: 'Failed to fetch stats' })
  }
}

module.exports.getPatientInsights = async (req, res) => {
  try {
    const period = req.query.period || 'this_month'
    const periodStart = getPeriodStart(period)

    const records = await prisma.visit.findMany({
      where: {
        arrived_at: { gte: periodStart },
        status: { in: ['done', 'archived', 'with_doctor', 'billing'] },
      },
      select: {
        patient_id: true,
        visit_type: true,
        diagnosis_code: true,
        diagnosis: true,
        arrived_at: true,
        patient: {
          select: { gender: true, age: true, allergies: true },
        },
      },
      orderBy: { arrived_at: 'desc' },
    })

    const shaped = records.map(r => ({
      patient_id: r.patient_id,
      patient_gender: r.patient.gender,
      patient_age: r.patient.age,
      allergies: r.patient.allergies,
      diagnosis_code: r.diagnosis_code,
      diagnosis: r.diagnosis,
      visit_type: r.visit_type,
      arrived_at: r.arrived_at,
    }))

    return res.json({ records: shaped })
  } catch (err) {
    console.error('getPatientInsights error:', err)
    return res.status(500).json({ error: 'Failed to load insights' })
  }
}

module.exports.getPatientDetail = async (req, res) => {
  const { id } = req.params
  if (!id) {
    return res.status(400).json({ error: 'Patient ID is required' })
  }

  const patientId = parseInt(id, 10)
  if (isNaN(patientId)) {
    return res.status(400).json({ error: 'Invalid patient ID' })
  }

  try {
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      include: {
        visits: {
          orderBy: { arrived_at: 'desc' },
          include: {
            doctor: { select: { username: true } },
            bill: {
              include: {
                payments: {
                  select: {
                    id: true, amount: true, method: true,
                    reference: true, stage: true, paid_at: true,
                  },
                },
              },
            },
            lab_requests: {
              select: {
                id: true, status: true, notes: true,
                urgency: true, requested_at: true, completed_at: true,
                items: {
                  select: {
                    id: true, test_name: true, status: true,
                    result: true, unit_cost: true, reference_range: true, flagged: true,
                  },
                },
              },
            },
            prescriptions: {
              include: {
                items: {
                  select: {
                    id: true, drug_name: true, dosage: true,
                    frequency: true, duration: true, quantity: true, unit_cost: true,
                  },
                },
              },
            },
            vitals: true,
          },
        },
      },
    })

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' })
    }

    const num = n => Number(n ?? 0)

    const total_visits = patient.visits.length
    const total_billed = patient.visits.reduce((s, v) => s + num(v.bill?.total_amount), 0)
    const total_paid = patient.visits.reduce((s, v) => {
      return s + (v.bill?.payments?.reduce((ps, p) => ps + num(p.amount), 0) || 0)
    }, 0)
    const unpaid_balance = Math.max(0, total_billed - total_paid)

    const visits = patient.visits.map(v => {
      const bill = v.bill
      const paid_amount = bill?.payments?.reduce((s, p) => s + num(p.amount), 0) || 0

      return {
        id: v.id,
        queue_number: v.queue_number,
        visit_type: v.visit_type,
        status: v.status,
        arrived_at: v.arrived_at,
        chief_complaint: v.chief_complaint,
        diagnosis: v.diagnosis,
        diagnosis_code: v.diagnosis_code,
        subjective: v.subjective,
        objective: v.objective,
        assessment: v.assessment,
        plan: v.plan,
        notes: v.notes,
        referred_by: v.referred_by,
        referrer_phone: v.referrer_phone,
        doctor: v.doctor ? { username: v.doctor.username } : null,
        vitals: v.vitals,
        bill: bill ? {
          id: bill.id,
          consultation_fee: bill.consultation_fee,
          consultation_fee_status: bill.consultation_fee_status,
          lab_fee: bill.lab_fee,
          medication_fee: bill.medication_fee,
          procedure_fee: bill.procedure_fee,
          stage2_status: bill.stage2_status,
          total_amount: bill.total_amount,
          fee_status: bill.fee_status,
          paid_amount,
          balance: Math.max(0, bill.total_amount - paid_amount),
          payments: bill.payments || [],
        } : null,
        lab_requests: v.lab_requests || [],
        prescriptions: (v.prescriptions || []).map(rx => ({
          id: rx.id,
          status: rx.status,
          notes: rx.notes,
          created_at: rx.created_at,
          dispensed_at: rx.dispensed_at,
          prescribed_by: rx.prescribed_by,
          items: rx.items || [],
        })),
      }
    })

    // Flat response — exactly what the slide-over expects
    return res.json({
      id: patient.id,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      phone: patient.phone,
      national_id: patient.national_id,
      blood_group: patient.blood_group,
      allergies: patient.allergies,
      created_at: patient.created_at,
      total_visits,
      total_billed,
      unpaid_balance,
      visits,
    })
  } catch (err) {
    console.error('getPatientDetail error:', err)
    return res.status(500).json({ error: 'Failed to fetch patient details' })
  }
}


module.exports.getAllStaff = async (req, res) => {
  try {
    const staff = await prisma.staff.findMany({
      where: { role: { not: 'admin' } },
      orderBy: { created_at: 'desc' },
      select: { id: true, username: true, role: true, is_active: true, created_at: true },
    })
    return res.json(staff)
  } catch (error) {
    console.error('getAllStaff error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch staff' })
  }
}

module.exports.addStaffPost = async (req, res) => {
  const { username, role, password } = req.body

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' })
  }

  const ALLOWED_ROLES = ['doctor', 'receptionist', 'lab_tech', 'pharmacist']
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ALLOWED_ROLES.join(', ')}` })
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12)
    const staff = await prisma.staff.create({
      data: { username, role, password: hashedPassword },
      select: { id: true, username: true, role: true, is_active: true, created_at: true },
    })
    return res.status(201).json({ message: 'Staff account created successfully', staff })
  } catch (error) {
    console.error('addStaffPost error:', error.message)
    return res.status(500).json({ error: 'Failed to create staff account' })
  }
}

module.exports.toggleStaffStatus = async (req, res) => {
  const { id } = req.params
  try {
    const staff = await prisma.staff.findUnique({ where: { id: Number(id) } })
    if (!staff) return res.status(404).json({ error: 'Staff not found' })

    const updatedStaff = await prisma.staff.update({
      where: { id: Number(id) },
      data: { is_active: !staff.is_active },
    })
    return res.json({ staff: updatedStaff })
  } catch (error) {
    console.error('toggleStaffStatus error:', error.message)
    return res.status(500).json({ error: 'Failed to toggle staff status' })
  }
}

module.exports.resetStaffPassword = async (req, res) => {
  const { id } = req.params
  const { password } = req.body

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }

  try {
    const hashed = await bcrypt.hash(password, 12)
    await prisma.staff.update({
      where: { id: Number(id) },
      data: { password: hashed },
    })
    return res.json({ message: 'Password reset successfully' })
  } catch (error) {
    console.error('resetStaffPassword error:', error.message)
    return res.status(500).json({ error: 'Failed to reset password' })
  }
}

module.exports.getLabTechs = async (req, res) => {
  try {
    const techs = await prisma.staff.findMany({
      where: { role: 'lab_tech', is_active: true },
      orderBy: { username: 'asc' },
      select: { id: true, username: true },
    })
    return res.json(techs)
  } catch (error) {
    console.error('getLabTechs error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch lab techs' })
  }
}

module.exports.getBillingQueueToday = async (req, res) => {
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
          orderBy: { paid_at: 'desc' },
          take: 1,
          select: { method: true }
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
        method: b.payments[0]?.method ?? null,
        created_at: b.created_at,
      }
    })

    return res.json(shaped)
  } catch (error) {
    console.error('getBillingQueueToday error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch bills' })
  }
}

module.exports.getBills = async (req, res) => {
  try {
    const {
      period = 'this_month',
      status,        // 'paid' | 'pending' | 'waived'
      visit_type,    // 'consultation' | 'injection' | 'family_planning' | 'direct_lab'
      search,        // patient name substring
      page = '1',
      limit = '50',
    } = req.query

    const range = getPeriodRange(period)
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      created_at: range,
    }

    if (status && status !== 'all') {
      where.fee_status = status
    }

    if (visit_type && visit_type !== 'all') {
      where.visit = { visit_type }
    }

    if (search) {
      where.visit = {
        ...where.visit,
        patient: { name: { contains: search, mode: 'insensitive' } },
      }
    }

    const [bills, total] = await Promise.all([
      prisma.bill.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { created_at: 'desc' },
        include: {
          visit: {
            select: {
              id: true,
              visit_type: true,
              status: true,
              arrived_at: true,
              patient: {
                select: { id: true, name: true, phone: true, gender: true },
              },
              doctor: {
                select: { username: true },
              },
            },
          },
          payments: {
            select: {
              id: true, amount: true, method: true, reference: true, stage: true, paid_at: true,
              cashier: { select: { username: true } }
            },
            orderBy: { paid_at: 'asc' },
          },
        },
      }),
      prisma.bill.count({ where }),
    ])

    const shaped = bills.map(b => {
      const paid_amount = b.payments.reduce((s, p) => s + p.amount, 0)

      const items = [
        b.consultation_fee > 0 && { name: 'Consultation', amount: b.consultation_fee, status: b.consultation_fee_status },
        b.lab_fee > 0 && { name: 'Lab Tests', amount: b.lab_fee, status: b.stage2_status },
        b.medication_fee > 0 && { name: 'Medication', amount: b.medication_fee, status: b.stage2_status },
        b.procedure_fee > 0 && { name: 'Procedure', amount: b.procedure_fee, status: b.stage2_status },
      ].filter(Boolean)

      return {
        id: b.id,
        visit_id: b.visit_id,
        patient_id: b.visit?.patient?.id,
        patient_name: b.visit?.patient?.name ?? '—',
        patient_phone: b.visit?.patient?.phone ?? null,
        patient_gender: b.visit?.patient?.gender ?? null,
        doctor: b.visit?.doctor?.username ?? null,
        visit_type: b.visit?.visit_type ?? null,
        visit_status: b.visit?.status ?? null,
        arrived_at: b.visit?.arrived_at ?? null,
        consultation_fee: b.consultation_fee,
        consultation_fee_status: b.consultation_fee_status,
        lab_fee: b.lab_fee,
        medication_fee: b.medication_fee,
        procedure_fee: b.procedure_fee,
        stage2_status: b.stage2_status,
        total_amount: b.total_amount,
        fee_status: b.fee_status,
        status: b.fee_status,
        paid_amount,
        balance: Math.max(0, b.total_amount - paid_amount),
        items,
        payments: b.payments.map(p => ({
          id: p.id,
          amount: p.amount,
          method: p.method,
          reference: p.reference ?? null,
          stage: p.stage,
          paid_at: p.paid_at,
          cashier: p.cashier?.username ?? null,
        })),
        created_at: b.created_at,
        updated_at: b.updated_at,
      }
    })

    const all = await prisma.bill.findMany({
      where,
      select: {
        total_amount: true, fee_status: true,
        payments: { select: { amount: true } },
      },
    })

    const summary = all.reduce((acc, b) => {
      const paid = b.payments.reduce((s, p) => s + p.amount, 0)
      acc.total_billed += b.total_amount
      acc.total_collected += paid
      acc.total_pending += Math.max(0, b.total_amount - paid)
      if (b.fee_status === 'paid') acc.paid_count++
      if (b.fee_status === 'pending') acc.pending_count++
      if (b.fee_status === 'waived') { acc.total_waived += b.total_amount; acc.waived_count++ }
      return acc
    }, { total_billed: 0, total_collected: 0, total_pending: 0, total_waived: 0, paid_count: 0, pending_count: 0, waived_count: 0 })

    return res.json({
      bills: shaped,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      summary,
    })
  } catch (err) {
    console.error('[admin] getBills:', err.message)
    return res.status(500).json({ error: 'Failed to fetch bills' })
  }
}


module.exports.getPayments = async (req, res) => {
  try {
    const {
      period = 'this_month',
      method,        // 'cash' | 'mpesa' | 'insurance' | 'other'
      stage,         // '1' | '2'
      search,        // patient name
      page = '1',
      limit = '50',
    } = req.query

    const range = getPeriodRange(period)
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = { paid_at: range }
    if (method && method !== 'all') where.method = method
    if (stage && stage !== 'all') where.stage = parseInt(stage)

    if (search) {
      where.bill = {
        visit: { patient: { name: { contains: search, mode: 'insensitive' } } },
      }
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { paid_at: 'desc' },
        include: {
          cashier: { select: { username: true } },
          bill: {
            select: {
              id: true,
              total_amount: true,
              visit: {
                select: {
                  id: true,
                  visit_type: true,
                  patient: { select: { name: true, phone: true } },
                },
              },
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ])

    const otcWhere = { sold_at: range }
    const otcSales = await prisma.otcSale.findMany({
      where: otcWhere,
      orderBy: { sold_at: 'desc' },
      select: {
        id: true, receipt_number: true, customer_name: true,
        total: true, payment_method: true, sold_at: true,
        sold_by_staff: { select: { username: true } },
        items: { select: { name: true, quantity: true, unit_price: true } },
      },
    })

    const by_method = { cash: 0, mpesa: 0, insurance: 0, other: 0 }
    payments.forEach(p => { by_method[p.method] = (by_method[p.method] || 0) + p.amount })
    otcSales.forEach(s => {
      const m = s.payment_method || 'other'
      by_method[m] = (by_method[m] || 0) + s.total
    })

    const total_clinic = payments.reduce((s, p) => s + p.amount, 0)
    const total_otc = otcSales.reduce((s, s2) => s + s2.total, 0)
    const total_collected = total_clinic + total_otc

    const shaped = payments.map(p => ({
      id: p.id,
      bill_id: p.bill_id,
      visit_id: p.bill?.visit?.id,
      patient_name: p.bill?.visit?.patient?.name ?? '—',
      patient_phone: p.bill?.visit?.patient?.phone ?? null,
      visit_type: p.bill?.visit?.visit_type ?? null,
      bill_total: p.bill?.total_amount ?? 0,
      amount: p.amount,
      method: p.method,
      reference: p.reference ?? null,
      stage: p.stage,
      cashier: p.cashier?.username ?? null,
      paid_at: p.paid_at,
      source: 'clinic',
    }))

    const shapedOtc = otcSales.map(s => ({
      id: `otc-${s.id}`,
      receipt: s.receipt_number,
      patient_name: s.customer_name,
      amount: s.total,
      method: s.payment_method,
      cashier: s.sold_by_staff?.username ?? null,
      paid_at: s.sold_at,
      source: 'pharmacy_otc',
      items: s.items,
    }))

    return res.json({
      payments: shaped,
      otc_sales: shapedOtc,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      summary: {
        total_clinic,
        total_otc,
        total_collected,
        by_method,
        stage1: payments.filter(p => p.stage === 1).reduce((s, p) => s + p.amount, 0),
        stage2: payments.filter(p => p.stage === 2).reduce((s, p) => s + p.amount, 0),
      },
    })
  } catch (err) {
    console.error('[admin] getPayments:', err.message)
    return res.status(500).json({ error: 'Failed to fetch payments' })
  }
}

module.exports.getLabRequests = async (req, res) => {
  const {
    page = 1, limit = 20, period = 'this_month',
    status, referred, tech_id, search,
  } = req.query

  const skip = (Number(page) - 1) * Number(limit)
  const range = getPeriodRange(period)

  const where = { requested_at: range }
  if (status && status !== 'all') where.status = status
  if (tech_id && tech_id !== 'all') where.tech_id = Number(tech_id)
  if (referred === 'referred') where.visit = { referred_by: { not: null } }
  if (referred === 'not_referred') where.visit = { referred_by: null }
  if (search) {
    where.OR = [
      { items: { some: { test_name: { contains: search, mode: 'insensitive' } } } },
      { visit: { patient: { name: { contains: search, mode: 'insensitive' } } } },
      { visit: { referred_by: { contains: search, mode: 'insensitive' } } },
    ]
  }

  try {
    const [requests, total] = await Promise.all([
      prisma.labRequest.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { requested_at: 'desc' },
        include: {
          tech: { select: { id: true, username: true } },
          items: {
            select: {
              id: true, test_name: true, category: true, reference_range: true,
              unit_cost: true, result: true, status: true, flagged: true,
            },
          },
          visit: {
            select: {
              id: true, visit_type: true, queue_number: true,
              referred_by: true, referrer_phone: true,
              patient: { select: { id: true, name: true, phone: true, age: true } },
            },
          },
        },
      }),
      prisma.labRequest.count({ where }),
    ])

    return res.json({ requests, total, page: Number(page), limit: Number(limit) })
  } catch (error) {
    console.error('getLabRequests error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch lab requests' })
  }
}


module.exports.getLabStats = async (req, res) => {
  const { period = 'this_month' } = req.query
  const range = getPeriodRange(period)

  try {
    const [total_tests, pending_count, referred_count, revenueResult, turnaroundData] = await Promise.all([
      prisma.labRequest.count({ where: { requested_at: range } }),
      prisma.labRequest.count({ where: { requested_at: range, status: { in: ['pending', 'in_progress'] } } }),
      prisma.labRequest.count({ where: { requested_at: range, visit: { visit_type: 'direct_lab' } } }),
      // FIXED: unit_cost lives on LabRequestItem, not LabRequest — filter
      // through the lab_request relation instead.
      prisma.labRequestItem.aggregate({
        where: { lab_request: { requested_at: range } },
        _sum: { unit_cost: true },
      }),
      prisma.labRequest.findMany({
        where: { requested_at: range, status: 'ready', completed_at: { not: null } },
        select: { requested_at: true, completed_at: true },
      }),
    ])

    let avg_turnaround_mins = 0
    if (turnaroundData.length > 0) {
      const totalMins = turnaroundData.reduce((sum, r) =>
        sum + (new Date(r.completed_at) - new Date(r.requested_at)) / 60000, 0)
      avg_turnaround_mins = Math.round(totalMins / turnaroundData.length)
    }

    return res.json({
      total_tests,
      lab_revenue: revenueResult._sum.unit_cost || 0,
      pending_count,
      referred_count,
      avg_turnaround_mins,
    })
  } catch (error) {
    console.error('getLabStats error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch lab stats' })
  }
}



module.exports.getLabStock = async (req, res) => {
  const { search } = req.query
  try {
    const where = search ? { name: { contains: search, mode: 'insensitive' } } : {}
    const stock = await prisma.labStock.findMany({ where, orderBy: { name: 'asc' } })
    return res.json({ stock })
  } catch (error) {
    console.error('getLabStock error:', error)
    return res.status(500).json({ error: 'Failed to fetch lab stock' })
  }
}

module.exports.createLabStockItem = async (req, res) => {
  const { name, current_stock, reorder_level, expiry_date, category, unit, unit_cost, supplier, batch_number } = req.body

  if (!name) return res.status(400).json({ error: 'Item name is required' })
  if (current_stock === undefined || current_stock === null) return res.status(400).json({ error: 'Current stock is required' })

  try {
    const item = await prisma.labStock.create({
      data: {
        name,
        category: category ?? null,
        current_stock: Number(current_stock),
        reorder_level: Number(reorder_level) || 0,
        unit: unit || 'units',
        unit_cost: Number(unit_cost) || 0,
        supplier: supplier ?? null,
        batch_number: batch_number ?? null,
        expiry_date: expiry_date ? new Date(expiry_date) : null,
      },
    })
    return res.status(201).json({ message: 'Stock item added', item })
  } catch (error) {
    console.error('createLabStockItem error:', error)
    return res.status(500).json({ error: 'Failed to add stock item' })
  }
}

module.exports.updateLabStockItem = async (req, res) => {
  const { id } = req.params
  const { name, current_stock, reorder_level, expiry_date, category, unit, unit_cost, supplier, batch_number } = req.body

  if (!name) return res.status(400).json({ error: 'Item name is required' })

  try {
    const existing = await prisma.labStock.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Stock item not found' })

    const item = await prisma.labStock.update({
      where: { id: Number(id) },
      data: {
        name,
        category: category ?? existing.category,
        current_stock: current_stock !== undefined ? Number(current_stock) : existing.current_stock,
        reorder_level: reorder_level !== undefined ? Number(reorder_level) : existing.reorder_level,
        unit: unit ?? existing.unit,
        unit_cost: unit_cost !== undefined ? Number(unit_cost) : existing.unit_cost,
        supplier: supplier ?? existing.supplier,
        batch_number: batch_number ?? existing.batch_number,
        expiry_date: expiry_date ? new Date(expiry_date) : existing.expiry_date,
      },
    })
    return res.json({ message: 'Stock item updated', item })
  } catch (error) {
    console.error('updateLabStockItem error:', error)
    return res.status(500).json({ error: 'Failed to update stock item' })
  }
}

module.exports.updateLabStockQuantity = async (req, res) => {
  const { id } = req.params
  const { quantity, adjustment } = req.body

  try {
    const existing = await prisma.labStock.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Stock item not found' })

    const newQuantity = adjustment !== undefined
      ? existing.current_stock + Number(adjustment)
      : Number(quantity)

    if (newQuantity < 0) return res.status(400).json({ error: 'Quantity cannot be negative' })

    const item = await prisma.labStock.update({
      where: { id: Number(id) },
      data: { current_stock: newQuantity },
    })
    return res.json({ message: 'Quantity updated', item })
  } catch (error) {
    console.error('updateLabStockQuantity error:', error)
    return res.status(500).json({ error: 'Failed to update quantity' })
  }
}

module.exports.deleteLabStockItem = async (req, res) => {
  const { id } = req.params
  try {
    const existing = await prisma.labStock.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Stock item not found' })

    await prisma.labStock.delete({ where: { id: Number(id) } })
    return res.json({ message: 'Stock item deleted' })
  } catch (error) {
    console.error('deleteLabStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to delete stock item' })
  }
}


// module.exports.getExpenses = async (req, res) => {
//   try {
//     const { domain = 'clinic', period = 'this_month', category } = req.query
//     const range = getPeriodRange(period)

//     const model = domain === 'pharmacy' ? prisma.pharmacyExpense : prisma.clinicExpense
//     const where = { incurred_at: range }
//     if (category && category !== 'all') where.category = category

//     const expenses = await model.findMany({
//       where,
//       orderBy: { incurred_at: 'desc' },
//       include: { recorded_by_staff: { select: { username: true } } },
//     })

//     return res.json({
//       expenses: expenses.map(e => shapeExpense(e, domain)),
//       stats: { total: expenses.reduce((s, e) => s + e.amount, 0) },
//     })
//   } catch (err) {
//     console.error('[admin] getExpenses:', err.message)
//     return res.status(500).json({ error: 'Failed to fetch expenses' })
//   }
// }
module.exports.getExpenses = async (req, res) =>{
  try {
    const { from, to, department } = req.query
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to dates are required' })
    }
    const { fromDate, toDate } = parseDateRange(from, to)
    const { page, limit, offset } = getPagination(req)
    const { start: todayStart, end: todayEnd } = todayRange()

    if (!department) {
      const [
        clinicItems,
        pharmacyItems,
        clinicSum,
        pharmacySum,
        clinicToday,
        pharmacyToday,
        clinicTodayCount,
        pharmacyTodayCount,
        clinicByCat,
        pharmacyByCat,
      ] = await Promise.all([
        prisma.clinicExpense.findMany({
          where: { incurred_at: { gte: fromDate, lte: toDate } },
          include: { recorded_by_staff: { select: { name: true } } },
          orderBy: { incurred_at: 'desc' },
        }),
        prisma.pharmacyExpense.findMany({
          where: { incurred_at: { gte: fromDate, lte: toDate } },
          include: { recorded_by_staff: { select: { name: true } } },
          orderBy: { incurred_at: 'desc' },
        }),
        prisma.clinicExpense.aggregate({
          where: { incurred_at: { gte: fromDate, lte: toDate } },
          _sum: { amount: true },
        }),
        prisma.pharmacyExpense.aggregate({
          where: { incurred_at: { gte: fromDate, lte: toDate } },
          _sum: { amount: true },
        }),
        prisma.clinicExpense.aggregate({
          where: { incurred_at: { gte: todayStart, lte: todayEnd } },
          _sum: { amount: true },
        }),
        prisma.pharmacyExpense.aggregate({
          where: { incurred_at: { gte: todayStart, lte: todayEnd } },
          _sum: { amount: true },
        }),
        prisma.clinicExpense.count({
          where: { incurred_at: { gte: todayStart, lte: todayEnd } },
        }),
        prisma.pharmacyExpense.count({
          where: { incurred_at: { gte: todayStart, lte: todayEnd } },
        }),
        prisma.clinicExpense.groupBy({
          by: ['category'],
          where: { incurred_at: { gte: fromDate, lte: toDate } },
          _sum: { amount: true },
        }),
        prisma.pharmacyExpense.groupBy({
          by: ['category'],
          where: { incurred_at: { gte: fromDate, lte: toDate } },
          _sum: { amount: true },
        }),
      ])

      const all = [
        ...clinicItems.map((e) => ({ ...e, department: 'reception' })),
        ...pharmacyItems.map((e) => ({ ...e, department: 'pharmacy' })),
      ].sort((a, b) => new Date(b.incurred_at) - new Date(a.incurred_at))

      const total = all.length
      const expenses = all.slice(offset, offset + limit)

      const byCategory = {}
      for (const g of [...clinicByCat, ...pharmacyByCat]) {
        const key = g.category || 'uncategorized'
        byCategory[key] = (byCategory[key] || 0) + (g._sum.amount || 0)
      }

      res.json({
        expenses: expenses.map((e) => ({
          id: e.id,
          description: e.description,
          amount: e.amount,
          category: e.category,
          recorded_by: e.recorded_by_staff?.name || 'Unknown',
          recorded_at: e.incurred_at,
          department: e.department,
        })),
        stats: {
          total: (clinicSum._sum.amount || 0) + (pharmacySum._sum.amount || 0),
          today_total: (clinicToday._sum.amount || 0) + (pharmacyToday._sum.amount || 0),
          today_count: clinicTodayCount + pharmacyTodayCount,
          by_department: {
            reception: clinicSum._sum.amount || 0,
            pharmacy: pharmacySum._sum.amount || 0,
          },
          by_category: byCategory,
        },
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
        total,
      })
    } else {
      const model = department === 'pharmacy' ? prisma.pharmacyExpense : prisma.clinicExpense
      const where = { incurred_at: { gte: fromDate, lte: toDate } }

      const [items, count, totalSum, todaySum, todayCount, categoryGroups] = await Promise.all([
        model.findMany({
          where,
          include: { recorded_by_staff: { select: { name: true } } },
          orderBy: { incurred_at: 'desc' },
          skip: offset,
          take: limit,
        }),
        model.count({ where }),
        model.aggregate({ where, _sum: { amount: true } }),
        model.aggregate({
          where: { ...where, incurred_at: { gte: todayStart, lte: todayEnd } },
          _sum: { amount: true },
        }),
        model.count({
          where: { ...where, incurred_at: { gte: todayStart, lte: todayEnd } },
        }),
        model.groupBy({
          by: ['category'],
          where,
          _sum: { amount: true },
        }),
      ])

      const byCategory = Object.fromEntries(
        categoryGroups.map((g) => [g.category || 'uncategorized', g._sum.amount || 0])
      )

      res.json({
        expenses: items.map((e) => ({
          id: e.id,
          description: e.description,
          amount: e.amount,
          category: e.category,
          recorded_by: e.recorded_by_staff?.name || 'Unknown',
          recorded_at: e.incurred_at,
        })),
        stats: {
          total: totalSum._sum.amount || 0,
          today_total: todaySum._sum.amount || 0,
          today_count: todayCount,
          by_category: byCategory,
        },
        page,
        pages: Math.max(1, Math.ceil(count / limit)),
        total: count,
      })
    }
  } catch (err) {
    console.error('Get expenses error:', err)
    res.status(500).json({ error: 'Failed to load expenses' })
  }
}

module.exports.getExpenseStats = async (req, res) => {
  try {
    const { domain = 'clinic', period = 'this_month' } = req.query
    const range = getPeriodRange(period)

    const model = domain === 'pharmacy' ? prisma.pharmacyExpense : prisma.clinicExpense

    const [allTime, inPeriod, today] = await Promise.all([
      model.aggregate({ _sum: { amount: true }, _count: true }),
      model.aggregate({ where: { incurred_at: range }, _sum: { amount: true }, _count: true }),
      model.aggregate({
        where: {
          incurred_at: {
            gte: (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })(),
            lte: (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d })(),
          },
        },
        _sum: { amount: true },
        _count: true,
      }),
    ])

    const rows = await model.findMany({
      where: { incurred_at: range },
      select: { amount: true, category: true },
    })

    const by_category = {}
    rows.forEach(r => {
      const cat = r.category || 'uncategorised'
      by_category[cat] = (by_category[cat] || 0) + r.amount
    })

    return res.json({
      total_amount: allTime._sum.amount ?? 0,
      total_amount_period: inPeriod._sum.amount ?? 0,
      entry_count: allTime._count ?? 0,
      entry_count_period: inPeriod._count ?? 0,
      today_amount: today._sum.amount ?? 0,
      today_count: today._count ?? 0,
      by_category,
    })
  } catch (err) {
    console.error('[admin] getExpenseStats:', err.message)
    return res.status(500).json({ error: 'Failed to fetch expense stats' })
  }
}

module.exports.createExpense = async (req, res) => {
  try {
    const { domain = 'clinic', description, amount, category, incurred_at } = req.body
    const staffId = req.user?.id ?? null

    if (!description?.trim()) {
      return res.status(400).json({ error: 'Description is required.' })
    }
    const parsedAmount = parseFloat(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number.' })
    }

    const date = incurred_at ? new Date(incurred_at) : new Date()
    const model = domain === 'pharmacy' ? prisma.pharmacyExpense : prisma.clinicExpense

    const expense = await model.create({
      data: {
        description: description.trim(),
        amount: Math.round(parsedAmount),
        category: category?.trim() || null,
        recorded_by: staffId,
        incurred_at: date,
        created_at: new Date(),
      },
      include: { recorded_by_staff: { select: { username: true } } },
    })

    return res.status(201).json({ success: true, expense: shapeExpense(expense, domain) })
  } catch (err) {
    console.error('[admin] createExpense:', err.message)
    return res.status(500).json({ error: 'Failed to record expense' })
  }
}

module.exports.deleteExpense = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const domain = req.query.domain || 'clinic'

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid expense ID.' })
    }

    const model = domain === 'pharmacy' ? prisma.pharmacyExpense : prisma.clinicExpense
    const existing = await model.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: 'Expense not found.' })

    await model.delete({ where: { id } })

    return res.json({ success: true })
  } catch (err) {
    console.error('[admin] deleteExpense:', err.message)
    return res.status(500).json({ error: 'Failed to delete expense' })
  }
}

module.exports.getSettings = async (req, res) => {
  try {
    const s = await getSettings()
    return res.json({
      settings: {
        name: s.name,
        tagline: s.tagline,
        address: s.address,
        phone: s.phone,
        email: s.email,
        pharmacy_settings: s.pharmacy_settings ?? null,
      },
    })
  } catch (err) {
    console.error('getSettings', err)
    return res.status(500).json({ error: 'Failed to fetch settings' })
  }
}

module.exports.patchSettings = async (req, res) => {
  try {
    const body = req.body
    const staffId = req.user?.id
    const username = req.user?.username ?? 'Admin'
    const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null

    const FIELDS = ['name', 'tagline', 'address', 'phone', 'email', 'lab_settings', 'pharmacy_settings']
    const data = {}
    for (const k of FIELDS) {
      if (k in body) data[k] = body[k]
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    // Constant id, upsert: a deleted or reseeded row recreates instead of
    // throwing P2025. The cache is never consulted on the write path.
    await prisma.clinicSettings.upsert({
      where: { id: SETTINGS_ID },
      update: data,
      create: { id: SETTINGS_ID, ...data },
    })

    await invalidateSettings()

    await writeAuditLog({
      staffId,
      user: username,
      action: 'Settings Updated',
      description: `Updated: ${Object.keys(data).join(', ')}`,
      category: 'staff',
      ipAddress: ip,
    })

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('patchSettings', err)
    await invalidateSettings().catch(() => { })
    return res.status(500).json({ error: 'Failed to save settings' })
  }
}


exports.getLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50))
    const { category, search } = req.query

    const where = {}
    if (category && category !== 'all') where.category = category
    if (search?.trim()) {
      const q = search.trim()
      where.OR = [
        { action: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { user: { contains: q, mode: 'insensitive' } },
      ]
    }

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { staff: { select: { role: true } } },
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ])

    const logs = rows.map((r) => ({
      id: r.id,
      category: r.category,
      action: r.action,
      description: r.description,
      user: r.user || 'System',
      role: r.staff?.role ?? null,
      ip: r.ip_address ?? null,
      timestamp: r.timestamp,
    }))

    res.json({ logs, total })
  } catch (err) {
    console.error('getLogs', err)
    res.status(500).json({ error: 'Failed to fetch logs' })
  }
}

exports.getLogStats = async (req, res) => {
  try {
    const range = todayRange()
    const [total_today, payment_today, patient_today] = await Promise.all([
      prisma.auditLog.count({ where: { timestamp: range } }),
      prisma.auditLog.count({ where: { timestamp: range, category: 'payment' } }),
      prisma.auditLog.count({ where: { timestamp: range, category: 'patient' } }),
    ])
    res.json({ total_today, payment_today, patient_today })
  } catch (err) {
    console.error('getLogStats', err)
    res.status(500).json({ error: 'Failed to fetch log stats' })
  }
}

module.exports.getSessions = async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { expires_at: { gt: new Date() } },
      include: { staff: { select: { username: true, role: true } } },
      orderBy: { created_at: 'desc' },
    })

    return res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        staff_id: s.staff_id,
        username: s.staff?.username ?? null,
        role: s.staff?.role ?? null,
        login_at: s.created_at,
        last_active: null,
        expires_at: s.expires_at,
      })),
    })
  } catch (err) {
    console.error('getSessions', err)
    return res.status(500).json({ error: 'Failed to fetch sessions' })
  }
}

module.exports.deleteSession = async (req, res) => {
  const id = parseInt(req.params.id)
  const staffId = req.user?.id
  const username = req.user?.username ?? 'Admin'
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null

  try {
    const session = await prisma.session.findUnique({
      where: { id },
      include: { staff: { select: { username: true } } },
    })
    if (!session) return res.status(404).json({ error: 'Session not found' })

    await prisma.session.delete({ where: { id } })
    await writeAuditLog({ staffId, user: username, action: 'Session Terminated', description: `Terminated session for ${session.staff?.username ?? 'unknown user'}`, category: 'staff', entity: 'Session', entityId: id, ipAddress: ip })

    return res.json({ success: true })
  } catch (err) {
    console.error('deleteSession', err)
    return res.status(500).json({ error: 'Failed to delete session' })
  }
}


module.exports.getDrugStock = async (req, res) => {
  const { search, category, expiry_filter, page = '1', limit = '20' } = req.query
  try {
    const where = {}

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { generic_name: { contains: search, mode: 'insensitive' } },
      ]
    }

    if (category && category !== 'all') where.category = category

    if (expiry_filter && expiry_filter !== 'all') {
      const now = new Date()
      const days = expiry_filter === '1month' ? 30 : 90
      const future = new Date()
      future.setDate(now.getDate() + days)
      where.batches = {
        some: {
          is_exhausted: false,
          expiry_date: { gte: now, lte: future },
        },
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        include: {
          batches: {
            where: { is_exhausted: false },
            orderBy: { expiry_date: 'asc' },
          },
        },
      }),
      prisma.product.count({ where }),
    ])

    const hasMore = skip + items.length < total
    const nextPage = hasMore ? parseInt(page) + 1 : null

    return res.json({ items, total, nextPage, hasMore, page: parseInt(page) })
  } catch (error) {
    console.error('getDrugStock error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch stock' })
  }
}


module.exports.createDrugStockItem = async (req, res) => {
  const {
    name, generic_name, category, sub_category, form, strength,
    current_stock, unit, reorder_level,
    unit_cost, normal_price, promotional_price, wholesale_price,
    supplier, expiry_date,
  } = req.body

  if (!name || !name.trim())
    return res.status(400).json({ error: 'Item name is required' })
  if (current_stock === undefined || current_stock === null)
    return res.status(400).json({ error: 'Current stock is required' })

  try {
    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.product.create({
        data: {
          name: name.trim(),
          generic_name: generic_name?.trim() || null,
          category: category || 'general',
          sub_category: sub_category?.trim() || null,
          form: form ?? null,
          strength: strength ?? null,
          current_stock: Number(current_stock),
          unit: unit || 'pieces',
          reorder_level: Number(reorder_level) || 0,
          unit_cost: Number(unit_cost) || 0,
          normal_price: Number(normal_price) || 0,
          promotional_price: Number(promotional_price) || 0,
          wholesale_price: Number(wholesale_price) || 0,
          supplier: supplier ?? null,
        },
      })

      if (Number(current_stock) > 0) {
        await tx.productBatch.create({
          data: {
            product_id: item.id,
            batch_number: '1',
            quantity: Number(current_stock),
            unit_cost: Number(unit_cost) || 0,
            expiry_date: expiry_date ? new Date(expiry_date) : null,
          },
        })

        await tx.stockMovement.create({
          data: {
            product_id: item.id,
            delta: Number(current_stock),
            reason: 'restock',
            ref_type: 'product_creation',
            balance_after: Number(current_stock),
            staff_id: req.user?.id ?? null,
            note: 'Initial stock',
          },
        })
      }

      return item
    })

    return res.status(201).json({ message: 'Item added', item: result })
  } catch (error) {
    if (error.code === 'P2002')
      return res.status(409).json({ error: 'An item with this name already exists' })
    console.error('createDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to add item' })
  }
}

module.exports.updateDrugStockItem = async (req, res) => {
  const { id } = req.params
  const {
    name, reorder_level, normal_price, promotional_price, wholesale_price,
    supplier,
  } = req.body

  if (!name || !name.trim())
    return res.status(400).json({ error: 'Item name is required' })

  try {
    const existing = await prisma.product.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Item not found' })

    const item = await prisma.product.update({
      where: { id: Number(id) },
      data: {
        name: name.trim(),
        reorder_level:
          reorder_level !== undefined ? Number(reorder_level) : existing.reorder_level,
        normal_price:
          normal_price !== undefined ? Number(normal_price) : existing.normal_price,
        promotional_price:
          promotional_price !== undefined
            ? Number(promotional_price)
            : existing.promotional_price,
        wholesale_price:
          wholesale_price !== undefined ? Number(wholesale_price) : existing.wholesale_price,
        supplier: supplier ?? existing.supplier,
      },
    })
    return res.json({ message: 'Item updated', item })
  } catch (error) {
    if (error.code === 'P2002')
      return res.status(409).json({ error: 'An item with this name already exists' })
    console.error('updateDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to update item' })
  }
}

module.exports.updateDrugStockQuantity = async (req, res) => {
  const { id } = req.params
  const { quantity, adjustment, expiry_date, unit_cost } = req.body

  try {
    const existing = await prisma.product.findUnique({
      where: { id: Number(id) },
      include: { batches: true },
    })
    if (!existing) return res.status(404).json({ error: 'Item not found' })

    const qty = adjustment !== undefined ? Number(adjustment) : Number(quantity)
    if (!Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ error: 'Quantity must be a positive number' })

    const newStock = existing.current_stock + qty

    let maxBatchNum = 0
    for (const b of existing.batches) {
      const num = parseInt(b.batch_number, 10)
      if (!isNaN(num) && num > maxBatchNum) maxBatchNum = num
    }
    const nextBatchNum = String(maxBatchNum + 1)

    const result = await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: Number(id) },
        data: { current_stock: newStock },
      })

      await tx.productBatch.create({
        data: {
          product_id: Number(id),
          batch_number: nextBatchNum,
          quantity: qty,
          unit_cost: Number(unit_cost) || existing.unit_cost,
          expiry_date: expiry_date ? new Date(expiry_date) : null,
        },
      })

      await tx.stockMovement.create({
        data: {
          product_id: Number(id),
          delta: qty,
          reason: 'restock',
          ref_type: 'manual_restock',
          balance_after: newStock,
          staff_id: req.user?.id ?? null,
          note: expiry_date
            ? `Batch ${nextBatchNum}, expires ${expiry_date}`
            : `Batch ${nextBatchNum}`,
        },
      })

      return tx.product.findUnique({
        where: { id: Number(id) },
        include: { batches: { where: { is_exhausted: false }, orderBy: { expiry_date: 'asc' } } },
      })
    })

    return res.json({ message: 'Quantity updated', item: result })
  } catch (error) {
    console.error('updateDrugStockQuantity error:', error.message)
    return res.status(500).json({ error: 'Failed to update quantity' })
  }
}

module.exports.deleteDrugStockItem = async (req, res) => {
  const { id } = req.params
  try {
    const existing = await prisma.product.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Item not found' })
    await prisma.product.delete({ where: { id: Number(id) } })
    return res.json({ message: 'Item deleted' })
  } catch (error) {
    console.error('deleteDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to delete item' })
  }
}

const CHARGE_CATEGORIES = ['consultation', 'procedure', 'lab', 'medication']


module.exports.getChargeTemplates = async (req, res) => {
  try {
    const templates = await prisma.chargeTemplate.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
    return res.json({ templates })
  } catch (error) {
    console.error('getChargeTemplates error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch charge templates' })
  }
}


module.exports.createChargeTemplate = async (req, res) => {
  const { name, category, amount, is_active } = req.body
  const currentUser = req.user

  if (!name || !name.trim()) return res.status(400).json({ error: 'template name is required!' })
  if (!CHARGE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Category must be one of: ${CHARGE_CATEGORIES.join(', ')}` })
  }
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt < 0) {
    return res.status(400).json({ error: 'Amount must be a non-negative number' })
  }

  try {
    const template = await prisma.chargeTemplate.create({
      data: { name: name.trim(), category, amount: Math.round(amt), is_active: is_active !== false },
    })
     await writeAuditLog({
      staffId: currentUser.id,
      user: currentUser.username,
      action: 'charge template created',
      description: `created charge template with id ${template.id})`,
      category: 'charge_template',
      entity: 'charge template',
      entityId: id,
      ipAddress: req.ip ?? req.headers['x-forwarded-for'] ?? null,
    })
    return res.status(201).json({ message: 'Template added', template })
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A template with this name already exists' })
    console.error('createChargeTemplate error:', error.message)
    return res.status(500).json({ error: 'Failed to add template' })
  }
}

module.exports.updateChargeTemplate = async (req, res) => {
  const { id } = req.params
  const { name, category, amount, is_active } = req.body
  const currentUser = req.user

  try {
    const existing = await prisma.chargeTemplate.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Template not found' })

    const data = {}
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' })
      data.name = name.trim()
    }
    if (category !== undefined) {
      if (!CHARGE_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `Category must be one of: ${CHARGE_CATEGORIES.join(', ')}` })
      }
      data.category = category
    }
    if (amount !== undefined) {
      const amt = Number(amount)
      if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Amount must be non-negative' })
      data.amount = Math.round(amt)
    }
    if (is_active !== undefined) data.is_active = !!is_active

    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No fields to update' })

    const template = await prisma.chargeTemplate.update({ where: { id: Number(id) }, data })
     await writeAuditLog({
      staffId: currentUser.id,
      user: currentUser.username,
      action: 'charge template updated',
      description: `updated charge template with id ${template.id})`,
      category: 'charge_template',
      entity: 'charge template',
      entityId: id,
      ipAddress: req.ip ?? req.headers['x-forwarded-for'] ?? null,
    })
    return res.json({ message: 'Template updated', template })
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A template with this name already exists' })
    console.error('updateChargeTemplate error:', error.message)
    return res.status(500).json({ error: 'Failed to update template' })
  }
}

module.exports.deleteChargeTemplate = async (req, res) => {
  const { id } = req.params
  const currentUser = req.user
  try {
    const existing = await prisma.chargeTemplate.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Template not found' })
    await prisma.chargeTemplate.delete({ where: { id: Number(id) } })
    await writeAuditLog({
      staffId: currentUser.id,
      user: currentUser.username,
      action: 'charge template deleted',
      description: `deleted charge template with id ${id})`,
      category: 'charge_template',
      entity: 'charge template',
      entityId: id,
      ipAddress: req.ip ?? req.headers['x-forwarded-for'] ?? null,
    })
    return res.json({ message: 'Template deleted' })
  } catch (error) {
    console.error('deleteChargeTemplate error:', error.message)
    return res.status(500).json({ error: 'Failed to delete template' })
  }
}

// GET /api/admin/lab-catalog
module.exports.getLabCatalog = async (req, res) => {
  try {
    const tests = await prisma.labTestCatalog.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        category: true,
        unit_cost: true,
        is_active: true,
        reference_range: true,
      },
    })
    res.json({ tests })
  } catch (err) {
    console.error('getLabCatalog error:', err)
    res.status(500).json({ error: 'Failed to fetch lab catalog' })
  }
}

// PATCH /api/admin/lab-catalog/:id
module.exports.updateLabCatalogItem = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { unit_cost, is_active } = req.body

    const data = {}
    if (unit_cost !== undefined) data.unit_cost = Math.max(0, Number(unit_cost) || 0)
    if (is_active !== undefined) data.is_active = !!is_active

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const item = await prisma.labTestCatalog.update({
      where: { id },
      data,
      select: { id: true, name: true, category: true, unit_cost: true, is_active: true },
    })
    res.json({ item })
  } catch (err) {
    console.error('updateLabCatalogItem error:', err)
    res.status(500).json({ error: 'Failed to update test' })
  }
}
module.exports.getRestocks = async (req, res) => {
  try {
    const restocks = await prisma.restockRequest.findMany({ orderBy: { requested_at: 'desc' } })
    const stats = restocks.reduce((a, r) => {
      if (r.status === 'pending') { a.pending++; a.pending_value += r.unit_cost * r.received_qty }
      else if (r.status === 'approved') a.approved++
      else if (r.status === 'rejected') a.rejected++
      return a
    }, { pending: 0, approved: 0, rejected: 0, pending_value: 0 })
    return res.json({ restocks, stats })
  } catch (error) {
    console.error('getRestocks error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch restock requests' })
  }
}

module.exports.verifyRestock = async (req, res) => {
  const id = Number(req.params.id)
  const { verification_notes, adjusted_qty, expiry_date } = req.body
  const currentUser = req.user
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.restockRequest.findUnique({ where: { id } })
      if (!r) throw Object.assign(new Error('Restock request not found'), { http: 404 })
      if (r.status !== 'pending')
        throw Object.assign(new Error('Request already processed'), { http: 409 })

      const qty = adjusted_qty != null ? Number(adjusted_qty) : r.received_qty || r.quantity
      if (!Number.isFinite(qty) || qty < 0)
        throw Object.assign(new Error('Invalid quantity'), { http: 400 })

      if (r.department === 'pharmacy') {
        if (!r.product_id)
          throw Object.assign(new Error('Restock request has no linked product'), { http: 422 })

        const product = await tx.product.findUnique({
          where: { id: r.product_id },
          include: { batches: true },
        })
        if (!product)
          throw Object.assign(new Error('Product no longer exists in the catalog'), { http: 404 })

        let maxBatchNum = 0
        for (const b of product.batches) {
          const num = parseInt(b.batch_number, 10)
          if (!isNaN(num) && num > maxBatchNum) maxBatchNum = num
        }
        const nextBatchNum = String(maxBatchNum + 1)

        const finalExpiry = expiry_date ? new Date(expiry_date) : r.expiry_date
        const finalUnitCost = r.unit_cost ?? product.unit_cost

        await tx.product.update({
          where: { id: product.id },
          data: { current_stock: { increment: qty } },
        })

        await tx.productBatch.create({
          data: {
            product_id: product.id,
            batch_number: nextBatchNum,
            expiry_date: finalExpiry,
            quantity: qty,
            unit_cost: finalUnitCost,
            received_by: currentUser.username,
            notes: verification_notes ?? null,
          },
        })

        await tx.stockMovement.create({
          data: {
            product_id: product.id,
            delta: qty,
            reason: 'restock',
            ref_type: 'restock_request',
            ref_id: r.id,
            balance_after: product.current_stock + qty,
            staff_id: currentUser.id ?? null,
            note: verification_notes ?? null,
          },
        })
      } else if (r.department === 'lab') {
        if (!r.lab_stock_id)
          throw Object.assign(new Error('Restock request has no linked lab stock item'), {
            http: 422,
          })
        const labItem = await tx.labStock.findUnique({ where: { id: r.lab_stock_id } })
        if (!labItem)
          throw Object.assign(new Error('Lab stock item no longer exists'), { http: 409 })
        await tx.labStock.update({
          where: { id: r.lab_stock_id },
          data: { current_stock: { increment: qty } },
        })
      }

      return tx.restockRequest.update({
        where: { id },
        data: {
          status: 'approved',
          received_qty: qty,
          verified_by: currentUser.username,
          verification_notes: verification_notes ?? null,
          verified_at: new Date(),
        },
      })
    })

    await writeAuditLog({
      staffId: currentUser.id,
      user: currentUser.username,
      action: 'Restock Verified',
      description: `Verified restock of ${updated.item_name ?? 'item'} (+${updated.received_qty} units)`,
      category: 'restock',
      entity: 'RestockRequest',
      entityId: id,
      ipAddress: ip,
    })

    return res.json({ success: true, restock: updated })
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message })
    if (err.code === 'P2025')
      return res.status(409).json({ error: 'Target stock item no longer exists' })
    console.error('verifyRestock error:', err.message)
    return res.status(500).json({ error: 'Failed to verify restock' })
  }
}

module.exports.rejectRestock = async (req, res) => {
  const id = Number(req.params.id)
  const { verification_notes } = req.body
  const currentUser = req.user
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null

  try {
    const r = await prisma.restockRequest.findUnique({ where: { id } })
    if (!r) return res.status(404).json({ error: 'Restock request not found' })
    if (r.status !== 'pending') return res.status(409).json({ error: 'Request already processed' })

    const updated = await prisma.restockRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        verified_by: currentUser.username,
        verification_notes: verification_notes ?? null,
        verified_at: new Date(),
      },
    })

    await writeAuditLog({
      staffId: currentUser.id, user: currentUser.username, action: 'Restock Rejected',
      description: `Rejected restock of ${updated.id}`,
      category: 'restock', entity: 'RestockRequest', entityId: id, ipAddress: ip,
    })

    return res.json({ success: true, restock: updated })
  } catch (err) {
    console.error('rejectRestock error:', err.message)
    return res.status(500).json({ error: 'Failed to reject restock' })
  }
}


module.exports.getReferrals = async (req, res) => {
  try {
    const rows = await prisma.Referral.findMany({
      include: {
        visit: {
          include: {
            patient: { select: { name: true } }
          },
        },
      },
      orderBy: { created_at: 'desc' },
    })

    const referrals = rows.map(shapeReferral)

    // ── Stats ────────────────────────────────────────────────────────────────
    const pending = referrals.filter(r => r.status === 'pending')
    const paid = referrals.filter(r => r.status === 'paid')

    const sum = (arr, key) => arr.reduce((acc, r) => acc + (r[key] ?? 0), 0)

    const stats = {
      total_referrals: referrals.length,
      pending_count: pending.length,
      paid_count: paid.length,
      total_commission: sum(referrals, 'commission_amount'),
      pending_commission: sum(pending, 'commission_amount'),
      paid_commission: sum(paid, 'amount_paid'),   // actual paid, not suggested
    }

    // ── By referrer ───────────────────────────────────────────────────────────
    // Groups referrals by referrer_name, computes per-doctor totals
    const referrerMap = {}
    for (const r of referrals) {
      const key = r.referrer_name
      if (!referrerMap[key]) {
        referrerMap[key] = {
          referrer_name: key,
          referrer_phone: r.referrer_phone,
          total_referrals: 0,
          total_commission: 0,
          pending_commission: 0,
          paid_commission: 0,
        }
      }
      referrerMap[key].total_referrals++
      referrerMap[key].total_commission += r.commission_amount
      if (r.status === 'pending') {
        referrerMap[key].pending_commission += r.commission_amount
      } else {
        referrerMap[key].paid_commission += r.amount_paid ?? r.commission_amount
      }
    }

    const by_referrer = Object.values(referrerMap)
      .sort((a, b) => b.pending_commission - a.pending_commission)

    return res.json({ referrals, stats, by_referrer })
  } catch (err) {
    console.error('getReferrals:', err.message)
    return res.status(500).json({ error: 'Failed to fetch referrals' })
  }
}

module.exports.createReferral = async (req, res) => {
  const {
    visit_id,
    referrer_name,
    referrer_phone,
    test_ordered,
    test_cost,
    commission_rate = 0.1,
    notes,
    referred_at,
  } = req.body

  // Validation
  if (!visit_id) return res.status(400).json({ error: 'visit_id is required' })
  if (!referrer_name?.trim()) return res.status(400).json({ error: 'referrer_name is required' })
  if (!test_ordered?.trim()) return res.status(400).json({ error: 'test_ordered is required' })
  if (!test_cost || isNaN(Number(test_cost)) || Number(test_cost) <= 0) {
    return res.status(400).json({ error: 'test_cost must be a positive number' })
  }

  const cost = Number(test_cost)
  const rate = Math.min(1, Math.max(0, Number(commission_rate) || 0.1))
  const amount = Math.round(cost * rate)

  try {
    // Confirm the visit exists and is a direct_lab visit
    const visit = await prisma.visit.findUnique({
      where: { id: Number(visit_id) },
    })

    if (!visit) {
      return res.status(404).json({ error: 'Visit not found' })
    }

    // Check no referral already exists for this visit
    const existing = await prisma.Referral.findUnique({
      where: { visit_id: Number(visit_id) },
    })
    if (existing) {
      return res.status(409).json({ error: 'A referral already exists for this visit' })
    }

    const referral = await prisma.Referral.create({
      data: {
        visit_id: Number(visit_id),
        referrer_name: referrer_name.trim(),
        referrer_phone: referrer_phone?.trim() ?? null,
        commission_amount: amount,
        notes: notes?.trim() ?? null,
        referred_at: referred_at ? new Date(referred_at) : new Date(),
        status: 'pending',
      },
      include: {
        visit: {
          include: {
            patient: { select: { name: true } },
          },
        },
      },
    })

    return res.status(201).json({ referral: shapeReferral(referral) })
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A referral already exists for this visit' })
    }
    console.error('createReferral:', err.message)
    return res.status(500).json({ error: 'Failed to create referral' })
  }
}

module.exports.payReferral = async (req, res) => {
  const referralId = Number(req.params.id)
  const currentUser = req.user
  if (!Number.isInteger(referralId)) {
    return res.status(400).json({ error: 'Invalid referral id' })
  }

  const { amount_paid, notes } = req.body
  if (!amount_paid || isNaN(Number(amount_paid)) || Number(amount_paid) <= 0) {
    return res.status(400).json({ error: 'amount_paid must be a positive number' })
  }

  try {
    const referral = await prisma.Referral.findUnique({
      where: { id: referralId },
    })

    if (!referral) {
      return res.status(404).json({ error: 'Referral not found' })
    }
    if (referral.status === 'paid') {
      return res.status(409).json({ error: 'This referral has already been marked as paid' })
    }

    const updated = await prisma.Referral.update({
      where: { id: referralId },
      data: {
        status: 'paid',
        paid_by: currentUser.username,
        commission_amount: Math.round(Number(amount_paid)),
        paid_at: new Date(),
        notes
      },
      include: {
        visit: {
          include: {
            patient: { select: { name: true } },
          },
        },
      },
    })
     await writeAuditLog({
      staffId: currentUser.id,
      user: currentUser.username,
      action: 'commission paid',
      description: `commision paid for visit ${updated.visit.id})`,
      category: 'referral',
      entity: 'referral',
      entityId: referral.id,
      ipAddress: req.ip ?? req.headers['x-forwarded-for'] ?? null,
    })
    return res.json({ referral: shapeReferral(updated) })
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Referral not found' })
    }
    console.error('payReferral:', err.message)
    return res.status(500).json({ error: 'Failed to mark referral as paid' })
  }
}

module.exports.getFinanceOverview = async (req, res) => {
  try {
    const { from, to } = req.query
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to dates are required' })
    }
    const { fromDate, toDate } = parseDateRange(from, to)

    const [
      paymentAgg,
      billAgg,
      clinicExpSum,
      pharmacyExpSum,
      clinicExpByCat,
      pharmacyExpByCat,
    ] = await Promise.all([
      prisma.payment.groupBy({
        by: ['method'],
        where: { paid_at: { gte: fromDate, lte: toDate } },
        _sum: { amount: true },
      }),
      prisma.bill.aggregate({
        where: { created_at: { gte: fromDate, lte: toDate } },
        _sum: {
          consultation_fee: true,
          lab_fee: true,
          medication_fee: true,
          procedure_fee: true,
        },
      }),
      prisma.clinicExpense.aggregate({
        where: { incurred_at: { gte: fromDate, lte: toDate } },
        _sum: { amount: true },
      }),
      prisma.pharmacyExpense.aggregate({
        where: { incurred_at: { gte: fromDate, lte: toDate } },
        _sum: { amount: true },
      }),
      prisma.clinicExpense.groupBy({
        by: ['category'],
        where: { incurred_at: { gte: fromDate, lte: toDate } },
        _sum: { amount: true },
      }),
      prisma.pharmacyExpense.groupBy({
        by: ['category'],
        where: { incurred_at: { gte: fromDate, lte: toDate } },
        _sum: { amount: true },
      }),
    ])

    const byPaymentMethod = { cash: 0, mpesa: 0, insurance: 0, other: 0 }
    let totalRevenue = 0
    for (const p of paymentAgg) {
      const amt = p._sum.amount || 0
      totalRevenue += amt
      if (byPaymentMethod.hasOwnProperty(p.method)) {
        byPaymentMethod[p.method] += amt
      } else {
        byPaymentMethod.other += amt
      }
    }

    const clinicTotal = clinicExpSum._sum.amount || 0
    const pharmacyTotal = pharmacyExpSum._sum.amount || 0
    const totalExpenses = clinicTotal + pharmacyTotal

    const byCategory = {}
    for (const g of [...clinicExpByCat, ...pharmacyExpByCat]) {
      const key = g.category || 'uncategorized'
      byCategory[key] = (byCategory[key] || 0) + (g._sum.amount || 0)
    }

    const daysInRange = Math.max(1, Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24)))

    res.json({
      revenue: {
        total: totalRevenue,
        consultation: billAgg._sum.consultation_fee || 0,
        procedures: billAgg._sum.procedure_fee || 0,
        lab: billAgg._sum.lab_fee || 0,
        medication: billAgg._sum.medication_fee || 0,
      },
      by_payment_method: byPaymentMethod,
      expenses: {
        total: totalExpenses,
        by_department: {
          reception: clinicTotal,
          pharmacy: pharmacyTotal,
        },
        by_category: byCategory,
      },
      days_in_range: daysInRange,
      net: totalRevenue - totalExpenses,
    })
  } catch (err) {
    console.error('Finance overview error:', err)
    res.status(500).json({ error: 'Failed to load finance overview' })
  }
}

// ─── 2. Outstanding Balances ─────────────────────────────────────────────────

// GET /api/admin/outstanding-balances
module.exports.getOutstandingBalances = async (req, res) => {
  try {
    const { from, to } = req.query
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to dates are required' })
    }
    const { fromDate, toDate } = parseDateRange(from, to)
    const { page, limit, offset } = getPagination(req)

    // ── Clinic: bills created in period that still have a balance ──
    const clinicRows = await prisma.$queryRaw`
      SELECT 
        'clinic' as source,
        b.visit_id as entity_id,
        p.id AS patient_id,
        p.name AS patient_name,
        p.phone AS patient_phone,
        b.total_amount AS total_bill,
        COALESCE(SUM(py.amount), 0)::int AS paid_amount,
        b.discount_amount AS waived_amount,
        (b.total_amount - COALESCE(SUM(py.amount), 0) - b.discount_amount)::int AS balance,
        v.arrived_at as created_at
      FROM bills b
      JOIN visits v ON v.id = b.visit_id
      JOIN patients p ON p.id = v.patient_id
      LEFT JOIN payments py ON py.bill_id = b.id
      WHERE b.created_at >= ${fromDate} AND b.created_at <= ${toDate}
      GROUP BY b.id, v.id, p.id, p.name, p.phone, b.total_amount, b.discount_amount, v.arrived_at
      HAVING b.total_amount - COALESCE(SUM(py.amount), 0) - b.discount_amount > 0
      ORDER BY balance DESC
    `

    // ── Pharmacy: customers with credit sales in period and current balance > 0 ──
    const pharmacyCustomers = await prisma.pharmacyCustomer.findMany({
      where: {
        sales: {
          some: {
            payment_method: 'credit',
            sold_at: { gte: fromDate, lte: toDate },
          },
        },
      },
      include: {
        sales: {
          where: { payment_method: 'credit' },
          select: { total: true, sold_at: true },
        },
        payments: {
          select: { amount: true, method: true, reference: true, created_at: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    const pharmacyRows = pharmacyCustomers
      .map((c) => {
        const totalCredit = c.sales.reduce((s, sale) => s + sale.total, 0)
        const totalPaid = c.payments
          .filter((p) => p.method !== 'waiver')
          .reduce((s, p) => s + p.amount, 0)
        const totalWaived = c.payments
          .filter((p) => p.method === 'waiver')
          .reduce((s, p) => s + p.amount, 0)
        const balance = totalCredit - totalPaid - totalWaived
        if (balance <= 0) return null

        return {
          source: 'pharmacy',
          entity_id: c.id,
          patient_id: c.id,
          patient_name: c.name,
          patient_phone: c.phone,
          total_bill: totalCredit,
          paid_amount: totalPaid,
          waived_amount: totalWaived,
          balance,
          created_at: c.sales[0]?.sold_at || new Date(),
        }
      })
      .filter(Boolean)

    // ── Merge, sort by balance desc, paginate in-memory ──
    const all = [...clinicRows, ...pharmacyRows].sort((a, b) => b.balance - a.balance)
    const total = all.length
    const outstanding = all.slice(offset, offset + limit)
    const totalOutstanding = all.reduce((s, r) => s + (r.balance || 0), 0)

    res.json({
      outstanding,
      total_outstanding: totalOutstanding,
      count: total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
    })
  } catch (err) {
    console.error('Outstanding balances error:', err)
    res.status(500).json({ error: 'Failed to load outstanding balances' })
  }
}

// PATCH /api/admin/outstanding-balances/:id
module.exports.updateOutstandingBalance = async (req, res) => {
  try {
    const entityId = Number(req.params.visitId)
    const { source, action, amount, method, reference, reason } = req.body

    if (!source || !['clinic', 'pharmacy'].includes(source)) {
      return res.status(400).json({ error: 'source must be clinic or pharmacy' })
    }

    // ═══════════════════════════════════════════════════════════
    // PHARMACY
    // ═══════════════════════════════════════════════════════════
    if (source === 'pharmacy') {
      const customerId = entityId

      if (action === 'settle') {
        const settleAmount = Number(amount)
        if (!Number.isFinite(settleAmount) || settleAmount <= 0) {
          return res.status(400).json({ error: 'Invalid settlement amount' })
        }

        const result = await prisma.$transaction(async (tx) => {
          const customer = await tx.pharmacyCustomer.findUnique({
            where: { id: customerId },
            include: {
              sales: { where: { payment_method: 'credit' }, select: { total: true } },
              payments: true,
            },
          })
          if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 })

          const totalCredit = customer.sales.reduce((s, sale) => s + sale.total, 0)
          const totalPaid = customer.payments
            .filter((p) => p.method !== 'waiver')
            .reduce((s, p) => s + p.amount, 0)
          const totalWaived = customer.payments
            .filter((p) => p.method === 'waiver')
            .reduce((s, p) => s + p.amount, 0)
          const balance = totalCredit - totalPaid - totalWaived

          if (balance <= 0) throw Object.assign(new Error('Customer has no outstanding balance'), { status: 400 })
          if (settleAmount > balance) throw Object.assign(new Error(`Amount exceeds balance of ${balance}`), { status: 400, meta: { balance } })

          await tx.customerPayment.create({
            data: {
              customer_id: customerId,
              amount: Math.round(settleAmount),
              method: method || 'cash',
              reference: reference || null,
              staff_id: req.user?.id || null,
            },
          })

          return { customer, totalCredit, totalPaid: totalPaid + settleAmount, totalWaived, newBalance: balance - settleAmount }
        })

        return res.json({
          row: {
            source: 'pharmacy',
            entity_id: customerId,
            patient_id: customerId,
            patient_name: result.customer.name,
            patient_phone: result.customer.phone,
            total_bill: result.totalCredit,
            paid_amount: result.totalPaid,
            waived_amount: result.totalWaived,
            balance: result.newBalance,
          },
        })
      }

      if (action === 'waive') {
        if (!reason?.trim()) {
          return res.status(400).json({ error: 'Reason is required for waiver' })
        }

        const result = await prisma.$transaction(async (tx) => {
          const customer = await tx.pharmacyCustomer.findUnique({
            where: { id: customerId },
            include: {
              sales: { where: { payment_method: 'credit' }, select: { total: true } },
              payments: true,
            },
          })
          if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 })

          const totalCredit = customer.sales.reduce((s, sale) => s + sale.total, 0)
          const totalPaid = customer.payments
            .filter((p) => p.method !== 'waiver')
            .reduce((s, p) => s + p.amount, 0)
          const totalWaived = customer.payments
            .filter((p) => p.method === 'waiver')
            .reduce((s, p) => s + p.amount, 0)
          const balance = totalCredit - totalPaid - totalWaived

          const waiveAmt =
            Number.isFinite(Number(amount)) && Number(amount) > 0 && Number(amount) < balance
              ? Number(amount)
              : balance

          await tx.customerPayment.create({
            data: {
              customer_id: customerId,
              amount: Math.round(waiveAmt),
              method: 'waiver',
              reference: reason.trim(),
              staff_id: req.user?.id || null,
            },
          })

          return { customer, totalCredit, totalPaid, totalWaived: totalWaived + waiveAmt, newBalance: balance - waiveAmt }
        })

        return res.json({
          row: {
            source: 'pharmacy',
            entity_id: customerId,
            patient_id: customerId,
            patient_name: result.customer.name,
            patient_phone: result.customer.phone,
            total_bill: result.totalCredit,
            paid_amount: result.totalPaid,
            waived_amount: result.totalWaived,
            balance: result.newBalance,
          },
        })
      }

      return res.status(400).json({ error: 'Invalid action' })
    }

    // ═══════════════════════════════════════════════════════════
    // CLINIC (your existing logic, untouched except param name)
    // ═══════════════════════════════════════════════════════════
    const visitId = entityId

    const bill = await prisma.bill.findUnique({
      where: { visit_id: visitId },
      include: {
        payments: true,
        visit: {
          include: {
            patient: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    })

    if (!bill) return res.status(404).json({ error: 'Bill not found' })

    const paidAmount = bill.payments.reduce((s, p) => s + p.amount, 0)
    const currentBalance = Math.max(0, bill.total_amount - paidAmount - bill.discount_amount)

    if (action === 'settle') {
      const settleAmount = Number(amount)
      if (!Number.isFinite(settleAmount) || settleAmount <= 0 || settleAmount > currentBalance) {
        return res.status(400).json({ error: 'Invalid settlement amount' })
      }

      await prisma.payment.create({
        data: {
          bill_id: bill.id,
          amount: Math.round(settleAmount),
          method: method || 'cash',
          reference: reference || null,
          stage: 2,
          cashier_id: req.user?.id || null,
        },
      })

      const newPaid = paidAmount + settleAmount
      const newBalance = Math.max(0, bill.total_amount - newPaid - bill.discount_amount)
      const newStatus = newBalance <= 0 ? 'paid' : bill.fee_status

      if (newStatus !== bill.fee_status) {
        await prisma.bill.update({ where: { id: bill.id }, data: { fee_status: newStatus } })
      }

      return res.json({
        row: {
          source: 'clinic',
          entity_id: visitId,
          patient_id: bill.visit.patient.id,
          patient_name: bill.visit.patient.name,
          patient_phone: bill.visit.patient.phone,
          total_bill: bill.total_amount,
          paid_amount: newPaid,
          waived_amount: bill.discount_amount,
          balance: newBalance,
        },
      })
    }

    if (action === 'waive') {
      if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required for waiver' })

      const waiveAmount =
        Number.isFinite(Number(amount)) && Number(amount) > 0 && Number(amount) < currentBalance
          ? Number(amount)
          : currentBalance

      const newDiscount = bill.discount_amount + waiveAmount
      const newBalance = Math.max(0, bill.total_amount - paidAmount - newDiscount)
      const newStatus = newBalance <= 0 ? 'waived' : bill.fee_status

      await prisma.bill.update({
        where: { id: bill.id },
        data: {
          discount_amount: newDiscount,
          discount_reason: reason.trim(),
          fee_status: newStatus,
        },
      })

      return res.json({
        row: {
          source: 'clinic',
          entity_id: visitId,
          patient_id: bill.visit.patient.id,
          patient_name: bill.visit.patient.name,
          patient_phone: bill.visit.patient.phone,
          total_bill: bill.total_amount,
          paid_amount: paidAmount,
          waived_amount: newDiscount,
          balance: newBalance,
        },
      })
    }

    res.status(400).json({ error: 'Invalid action' })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.meta })
    console.error('Update outstanding error:', err)
    res.status(500).json({ error: 'Failed to update balance' })
  }
}

exports.getDebtBook = async (req, res) => {
  try {
    const customers = await prisma.pharmacyCustomer.findMany({
      where: {
        sales: { some: { payments: { some: { method: 'credit' } } } },
      },
      include: {
        sales: {
          where: { payments: { some: { method: 'credit' } } },
          include: { payments: { where: { method: 'credit' } } },
        },
        payments: true,
      },
      orderBy: { name: 'asc' },
    })

    const debtors = customers
      .map((c) => {
        const totalCredit = c.sales.reduce((sum, sale) => {
          const creditAmount = sale.payments
            .filter((p) => p.method === 'credit')
            .reduce((s, p) => s + p.amount, 0)
          return sum + creditAmount
        }, 0)

        const totalPaid = c.payments.reduce((sum, p) => sum + p.amount, 0)
        const balance = totalCredit - totalPaid

        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          total_credit: totalCredit,
          total_paid: totalPaid,
          balance,
          last_sale: c.sales.at(-1)?.sold_at,
        }
      })
      .filter((d) => d.balance > 0)

    res.json({
      debtors,
      stats: {
        count: debtors.length,
        total_outstanding: debtors.reduce((s, d) => s + d.balance, 0),
      },
    })
  } catch (err) {
    console.error('getDebtBook', err)
    res.status(500).json({ error: 'Failed to load debt book' })
  }
}

// ─── COLLECT PAYMENT (admin/cashier) ──────────────────────────────────────────

exports.collectCustomerPayment = async (req, res) => {
  const currentUser = req.user
  const { customer_id, amount, method, reference } = req.body

  const customerId = parseInt(customer_id)
  const payAmount = parseInt(amount)

  if (!Number.isInteger(customerId)) {
    return res.status(400).json({ error: 'customer_id required' })
  }
  if (!Number.isInteger(payAmount) || payAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const customer = await tx.pharmacyCustomer.findUnique({
        where: { id: customerId },
        include: {
          sales: { include: { payments: { where: { method: 'credit' } } } },
          payments: true,
        },
      })
      if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 })

      const totalCredit = customer.sales.reduce(
        (sum, sale) => sum + sale.payments.reduce((s, p) => s + p.amount, 0),
        0
      )
      const totalPaid = customer.payments.reduce((sum, p) => sum + p.amount, 0)
      const balance = totalCredit - totalPaid

      if (balance <= 0) {
        throw Object.assign(new Error('Customer has no outstanding balance'), { status: 400 })
      }
      if (payAmount > balance) {
        throw Object.assign(
          new Error(`Amount exceeds balance of ${balance}`),
          { status: 400, meta: { balance } }
        )
      }

      const payment = await tx.customerPayment.create({
        data: {
          customer_id: customerId,
          amount: payAmount,
          method: method || 'cash',
          reference: (typeof reference === 'string' && reference.trim()) || null,
          staff_id: currentUser?.id,
        },
      })

      return { customer, payment, newBalance: balance - payAmount }
    }, { timeout: 10000 })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'credit_payment',
      description: `Collected ${payAmount} from ${result.customer.name}. Remaining: ${result.newBalance}`,
      category: 'pharmacy_credit',
      entity: 'pharmacy_customer',
      entityId: customerId,
      ipAddress: req.ip ?? null,
    })

    res.json({
      success: true,
      payment_id: result.payment.id,
      customer: result.customer.name,
      new_balance: result.newBalance,
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.meta })
    console.error('collectCustomerPayment', err)
    res.status(500).json({ error: 'Failed to record payment' })
  }
}