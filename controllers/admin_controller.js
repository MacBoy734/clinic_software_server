/**
 * controllers/adminController.js
 *
 * All admin endpoints for the clinic system, including the finance/FinanceTab
 * endpoints that used to live in controllers/financeController.js.
 *
 * Sections:
 *   1.  Shared helpers
 *   2.  Overview
 *   3.  Revenue (dashboard chart + full finance report + reports stats)
 *   4.  Patients / Visits report
 *   5.  Staff
 *   6.  Bills (today's billing queue + full finance bills ledger)
 *   7.  Payments (finance ledger)
 *   8.  Lab Requests
 *   9.  Lab Stats
 *   10. Lab Stock
 *   11. Expenses (list / stats / create / delete)
 *   12. Settings
 *   13. Audit Log
 *   14. Sessions
 */

const bcrypt = require('bcryptjs')
const prisma = require('../lib/prisma')
const {
  writeAuditLog,
  getPeriodRange,
  todayRange,
  lastNDays,
  endOfDay,
  dayLabel
} = require('../utils/helpers')

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ADMIN-SPECIFIC HELPERS  (not generic enough for utils/helpers)
// ═══════════════════════════════════════════════════════════════════════════════

// getPeriodStart — kept locally because getPatients / getPatientStats use
// { gte: periodStart } (open-ended) rather than the { gte, lte } range that
// getPeriodRange returns. Changing those queries would alter their behaviour.
function getPeriodStart(period) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (period === 'today') return d
  if (period === 'this_week') { d.setDate(d.getDate() - d.getDay()); return d }
  if (period === 'this_month') { d.setDate(1); return d }
  if (period === 'this_year') { d.setMonth(0, 1); return d }
  return d
}

// monthLabel — only used in this controller for chart axis labels.
function monthLabel(date) {
  return date.toLocaleDateString('en-KE', { month: 'short', year: '2-digit' })
}

// parseDateRangeQuery / daysBetween — used by the custom date-range chart
// endpoints in section 3. Admin-specific, not needed elsewhere.
function parseDateRangeQuery(query) {
  const fallbackDays = lastNDays(7)
  const fallbackStart = fallbackDays[0]
  const fallbackEnd = new Date()
  fallbackEnd.setHours(23, 59, 59, 999)

  const start = query.start ? new Date(query.start) : fallbackStart
  const end = query.end ? new Date(query.end) : fallbackEnd

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { start: fallbackStart, end: fallbackEnd }
  }

  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function daysBetween(start, end) {
  const days = []
  const cursor = new Date(start)
  cursor.setHours(0, 0, 0, 0)
  while (cursor <= end) {
    days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

// FIXED: was `prisma.settings` — that model doesn't exist in the schema.
// The clinic-wide config singleton is `ClinicSettings` (id: 1).
async function getOrCreateSettings() {
  let settings = await prisma.clinicSettings.findFirst()
  if (!settings) {
    settings = await prisma.clinicSettings.create({ data: { id: 1 } })
  }
  return settings
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

// FIXED: test_name / result / unit_cost live on LabRequestItem, not
// LabRequest, since the RESTRUCTURED schema split one-request-per-test into
// one-order-group (LabRequest) with many test items (LabRequestItem). Pull
// them through the `items` relation instead of selecting them directly off
// LabRequest.
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
    id:                r.id,
    visit_id:          r.visit_id,
    status:            r.status,
    referrer_name:     r.referrer_name,
    referrer_phone:    r.referrer_phone ?? null,
    patient_name:      r.visit?.patient?.name ?? '—',
    test_ordered:      r.test_ordered,
    test_cost:         r.test_cost,
    commission_rate:   r.commission_rate,
    commission_amount: r.commission_amount,
    notes:             r.notes ?? null,
    referred_at:       r.referred_at,
    paid_at:           r.paid_at ?? null,
    paid_by:           r.paid_by ?? null,
    amount_paid:       r.amount_paid ?? null,
  }
}

// Flattens LabRequest -> items into one row per test, matching the shape
// the frontend expects (test_name directly on each lab_requests entry).
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

// ═══════════════════════════════════════════════════════════════════════════════
// 2. OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.getAdminOverview = async (req, res) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  try {
    const [
      visitsToday,
      paymentsToday,
      allBills,
      activeStaff,
      allDrugStock,
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
      prisma.drugStock.findMany({
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

    const lowDrugs = allDrugStock
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

// ═══════════════════════════════════════════════════════════════════════════════
// 3. REVENUE / REPORTS STATS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/revenue/week — lightweight 7-day chart used on the dashboard
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

// GET /api/admin/finance/revenue?period=this_month — full FinanceTab revenue report
//
// Revenue sources:
//   Clinic revenue   = payments on Bills (consultation, lab, procedure fees)
//   Pharmacy revenue = OtcSale totals (walk-in pharmacy sales)
//
// Net Income = (clinic_revenue + pharmacy_revenue) - (clinic_expenses + pharmacy_expenses)
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

// GET /api/admin/stats?period= — used by ReportsTab's Revenue + Visits sub-tabs
module.exports.getAdminRevenueReport = async (req, res) => {
  try {
    const period = req.query.period || 'this_month'
    const range = getPeriodRange(period)

    const visits = await prisma.visit.findMany({
      where: { arrived_at: range },
      select: {
        id: true,
        visit_type: true,
        status: true,
        arrived_at: true,
      },
    })

    const payments = await prisma.payment.findMany({
      where: { paid_at: range },
      select: { amount: true, method: true },
    })

    const total_visits = visits.length

    const msInDay = 24 * 60 * 60 * 1000
    const daysInPeriod = Math.max(
      1,
      Math.ceil((range.lte.getTime() - range.gte.getTime()) / msInDay),
    )
    const avg_per_day = total_visits > 0
      ? Math.round((total_visits / daysInPeriod) * 10) / 10
      : 0

    const doneCount = visits.filter(v => v.status === 'done').length
    const completion_rate = total_visits > 0
      ? Math.round((doneCount / total_visits) * 100)
      : 0

    const by_visit_type = {}
    for (const v of visits) {
      by_visit_type[v.visit_type] = (by_visit_type[v.visit_type] || 0) + 1
    }

    const most_common_type = Object.entries(by_visit_type)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    const total_revenue = payments.reduce((s, p) => s + p.amount, 0)

    const by_payment_method = { cash: 0, mpesa: 0, insurance: 0, other: 0 }
    for (const p of payments) {
      const m = p.method || 'other'
      by_payment_method[m] = (by_payment_method[m] || 0) + p.amount
    }

    const chartDays = lastNDays(7)
    const by_day = chartDays.map(day => {
      const dayEnd = endOfDay(day)
      const count = visits.filter(v => {
        const t = new Date(v.arrived_at)
        return t >= day && t <= dayEnd
      }).length
      return { day: dayLabel(day), count }
    })

    const by_status = {}
    for (const v of visits) {
      by_status[v.status] = (by_status[v.status] || 0) + 1
    }

    return res.json({
      period,
      stats: {
        total_visits,
        avg_per_day,
        most_common_type,
        completion_rate,
        done_count: doneCount,
        total_revenue,
        by_payment_method,
      },
      by_day,
      by_visit_type,
      by_status,
    })
  } catch (err) {
    console.error('[adminStats] getAdminRevenueReport:', err.message)
    return res.status(500).json({ error: 'Failed to fetch admin stats' })
  }
}

// GET /api/admin/visits?period=&status=&visit_type=&fee_status=&search=&page=&limit=
module.exports.getAdminVisitsReport = async (req, res) => {
  const {
    period = 'today',
    status,
    visit_type,
    fee_status,
    search,
    page = '1',
    limit = '20',
  } = req.query

  const skip = (parseInt(page) - 1) * parseInt(limit)
  const range = getPeriodRange(period)

  const where = { arrived_at: range }

  if (status && status !== 'all') where.status = status
  if (visit_type && visit_type !== 'all') where.visit_type = visit_type
  if (fee_status && fee_status !== 'all') where.bill = { fee_status }

  if (search && search.trim()) {
    const q = search.trim()
    where.patient = {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { national_id: { contains: q, mode: 'insensitive' } },
      ],
    }
  }

  try {
    const [visits, total] = await Promise.all([
      prisma.visit.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { arrived_at: 'desc' },
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              age: true,
              gender: true,
              phone: true,
              national_id: true,
              blood_group: true,
              allergies: true,
            },
          },

          doctor: {
            select: { id: true, username: true },
          },

          bill: {
            include: {
              payments: {
                select: {
                  id: true,
                  amount: true,
                  method: true,
                  stage: true,
                  paid_at: true,
                },
                orderBy: { paid_at: 'asc' },
              },
            },
          },

          // FIXED: schema has test_name/result/unit_cost on LabRequestItem,
          // not LabRequest — pull through the `items` relation.
          lab_requests: {
            include: {
              items: {
                select: {
                  id: true,
                  test_name: true,
                  status: true,
                  result: true,
                  unit_cost: true,
                },
              },
            },
          },

          prescriptions: {
            include: {
              items: {
                select: {
                  id: true,
                  drug_name: true,
                  dosage: true,
                  frequency: true,
                  duration: true,
                  quantity: true,
                  unit_cost: true,
                },
                orderBy: { id: 'asc' },
              },
            },
            orderBy: { created_at: 'asc' },
          },
        },
      }),

      prisma.visit.count({ where }),
    ])

    const [allVisits, revenueResult] = await Promise.all([
      prisma.visit.findMany({
        where,
        select: {
          id: true,
          status: true,
          referred_by: true,
          bill: { select: { fee_status: true, total_amount: true } },
        },
      }),
      prisma.payment.aggregate({
        where: { paid_at: range, bill: { visit: { arrived_at: range } } },
        _sum: { amount: true },
      }),
    ])

    const stats = {
      total_visits: allVisits.length,
      completed: allVisits.filter(v => v.status === 'done' || v.status === 'archived').length,
      pending_payment: allVisits.filter(v => v.bill?.fee_status === 'pending').length,
      total_revenue: revenueResult._sum.amount ?? 0,
      referred_count: allVisits.filter(v => !!v.referred_by).length,
    }

    const shaped = visits.map(v => ({
      id: v.id,
      queue_number: v.queue_number ?? null,
      visit_type: v.visit_type,
      status: v.status,
      arrived_at: v.arrived_at,
      // NOTE: Visit has no `completed_at` column in the schema — this will
      // always be null. Completion is tracked via status === 'done' instead.
      completed_at: null,
      referred_by: v.referred_by ?? null,
      referrer_phone: v.referrer_phone ?? null,
      diagnosis: v.diagnosis ?? null,
      notes: v.notes ?? null,

      patient: v.patient ? {
        id: v.patient.id,
        name: v.patient.name,
        age: v.patient.age ?? null,
        gender: v.patient.gender ?? null,
        phone: v.patient.phone ?? null,
        national_id: v.patient.national_id ?? null,
        blood_group: v.patient.blood_group ?? null,
        allergies: v.patient.allergies ?? null,
      } : null,

      doctor: v.doctor ? {
        id: v.doctor.id,
        username: v.doctor.username,
      } : null,

      bill: v.bill ? {
        id: v.bill.id,
        consultation_fee: v.bill.consultation_fee,
        consultation_fee_status: v.bill.consultation_fee_status,
        lab_fee: v.bill.lab_fee,
        medication_fee: v.bill.medication_fee,
        procedure_fee: v.bill.procedure_fee,
        total_amount: v.bill.total_amount,
        fee_status: v.bill.fee_status,
        stage2_status: v.bill.stage2_status ?? null,
        payments: v.bill.payments.map(p => ({
          id: p.id,
          amount: p.amount,
          method: p.method,
          stage: p.stage,
          paid_at: p.paid_at,
        })),
      } : null,

      lab_requests: flattenLabRequests(v.lab_requests),

      prescriptions: v.prescriptions.map(rx => ({
        id: rx.id,
        status: rx.status,
        dispensed_at: rx.dispensed_at ?? null,
        notes: rx.notes ?? null,
        items: rx.items.map(item => ({
          id: item.id,
          drug_name: item.drug_name,
          dosage: item.dosage ?? null,
          frequency: item.frequency ?? null,
          duration: item.duration ?? null,
          quantity: item.quantity ?? null,
          unit_cost: item.unit_cost ?? 0,
        })),
      })),
    }))

    return res.json({
      visits: shaped,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      stats,
    })
  } catch (err) {
    console.error('[admin] getAdminVisitsReport:', err.message)
    return res.status(500).json({ error: 'Failed to fetch visits' })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PATIENTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/patients?page=&limit=&period=&visit_type=&fee_status=&gender=&search=
module.exports.getPatients = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    period = 'this_month',
    visit_type,
    fee_status,
    gender,
    search,
  } = req.query

  const skip = (Number(page) - 1) * Number(limit)
  const periodStart = getPeriodStart(period)

  const patientWhere = {}
  if (gender && gender !== 'all') patientWhere.gender = gender
  if (search) {
    patientWhere.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { national_id: { contains: search, mode: 'insensitive' } },
    ]
  }

  const visitWhere = { arrived_at: { gte: periodStart } }
  if (visit_type && visit_type !== 'all') visitWhere.visit_type = visit_type
  if (fee_status && fee_status !== 'all') visitWhere.bill = { fee_status }

  patientWhere.visits = { some: visitWhere }

  try {
    const [patients, total] = await Promise.all([
      prisma.patient.findMany({
        where: patientWhere,
        skip,
        take: Number(limit),
        orderBy: { updated_at: 'desc' },
        include: {
          visits: {
            where: visitWhere,
            orderBy: { arrived_at: 'desc' },
            take: 1,
            include: { bill: { select: { fee_status: true, total_amount: true } } },
          },
          _count: { select: { visits: true } },
        },
      }),
      prisma.patient.count({ where: patientWhere }),
    ])

    const shaped = await Promise.all(patients.map(async (p) => {
      const lastVisit = p.visits[0] ?? null

      const bills = await prisma.bill.findMany({
        where: { visit: { patient_id: p.id, arrived_at: { gte: periodStart } } },
        select: { total_amount: true, fee_status: true },
      })

      const totalBilled = bills.reduce((s, b) => s + (b.total_amount ?? 0), 0)
      const unpaidBalance = bills
        .filter(b => b.fee_status === 'pending')
        .reduce((s, b) => s + (b.total_amount ?? 0), 0)

      return {
        id: p.id,
        name: p.name,
        age: p.age,
        gender: p.gender,
        phone: p.phone,
        national_id: p.national_id,
        blood_group: p.blood_group,
        allergies: p.allergies,
        total_visits: p._count.visits,
        last_visit_date: lastVisit?.arrived_at ?? null,
        last_visit_type: lastVisit?.visit_type ?? null,
        last_diagnosis: lastVisit?.diagnosis ?? null,
        total_billed: totalBilled,
        unpaid_balance: unpaidBalance,
      }
    }))

    return res.json({ patients: shaped, total, page: Number(page), limit: Number(limit) })
  } catch (err) {
    console.error('getPatients:', err)
    return res.status(500).json({ error: 'Failed to fetch patients' })
  }
}

// GET /api/admin/patients/stats?period=
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

// GET /api/admin/patients/:id
module.exports.getPatientDetail = async (req, res) => {
  const { id } = req.params

  try {
    const patient = await prisma.patient.findUnique({
      where: { id: Number(id) },
      include: {
        visits: {
          orderBy: { arrived_at: 'desc' },
          include: { ...VISIT_INCLUDE, vitals: true },
          // VISIT_INCLUDE MUST include: bill { include: { payments: true } }
        },
      },
    })

    if (!patient) return res.status(404).json({ error: 'Patient not found' })

    const visits = patient.visits
    const num = n => Number(n ?? 0)

    // Normalize bill so paid_amount/balance exist even if not stored as columns.
    const billView = b => {
      if (!b) return null
      const paid = b.paid_amount != null
        ? num(b.paid_amount)
        : (b.payments ?? []).reduce((s, p) => s + num(p.amount), 0)
      const balance = b.balance != null
        ? num(b.balance)
        : Math.max(0, num(b.total_amount) - paid)
      return { ...b, paid_amount: paid, balance }
    }

    // Flatten labs once; reuse for payload and summary.
    const visitLabs  = visits.map(v => flattenLabRequests(v.lab_requests))
    const allLabItems = visitLabs.flatMap(reqs => reqs.flatMap(r => r.items ?? []))

    const bills        = visits.map(v => billView(v.bill)).filter(Boolean)
    const total_billed = bills.reduce((s, b) => s + num(b.total_amount), 0)
    const total_paid   = bills.reduce((s, b) => s + b.paid_amount, 0)

    return res.json({
      patient: {
        id: patient.id,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        phone: patient.phone,
        national_id: patient.national_id,
        blood_group: patient.blood_group,
        allergies: patient.allergies,
        created_at: patient.created_at,
      },
      financial_summary: {
        total_billed,
        total_paid,
        unpaid_balance: Math.max(0, total_billed - total_paid),
        by_category: {
          consultation: bills.reduce((s, b) => s + num(b.consultation_fee), 0),
          lab:          bills.reduce((s, b) => s + num(b.lab_fee), 0),
          medication:   bills.reduce((s, b) => s + num(b.medication_fee), 0),
          procedure:    bills.reduce((s, b) => s + num(b.procedure_fee), 0),
        },
      },
      lab_summary: {
        total_tests:   allLabItems.length,
        tests_ready:   allLabItems.filter(i => i.status === 'ready').length,
        tests_pending: allLabItems.filter(i => i.status !== 'ready').length,
        tests_flagged: allLabItems.filter(i => i.flagged).length,
      },
      visit_summary: {
        total: visits.length,
        last_visit: visits[0]?.arrived_at ?? null,
        by_type: visits.reduce((acc, v) => {
          acc[v.visit_type] = (acc[v.visit_type] ?? 0) + 1
          return acc
        }, {}),
      },
      visits: visits.map((v, idx) => ({
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
        has_lab_results: (visitLabs[idx] ?? []).some(r => (r.items ?? []).some(i => i.status === 'ready')),
        doctor: v.doctor ? { username: v.doctor.username } : null,
        vitals: v.vitals ?? null,
        bill: billView(v.bill),
        lab_requests: visitLabs[idx],
        prescriptions: v.prescriptions.map(rx => ({
          id: rx.id,
          status: rx.status,
          notes: rx.notes,
          created_at: rx.created_at,
          dispensed_at: rx.dispensed_at,
          prescribed_by: rx.prescriber?.username ?? null,
          pharmacist:    rx.pharmacist?.username ?? null,
          items: rx.items,
        })),
      })),
    })
  } catch (err) {
    console.error('getPatientDetail:', err)
    return res.status(500).json({ error: 'Failed to fetch patient' })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. STAFF
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// 6. BILLS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/bills/queue — today's billing queue (front-desk cashier view)
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

// GET /api/admin/bills?period=&status=&visit_type=&search=&page=&limit=
// Full FinanceTab bills ledger — every Bill with visit info, patient name,
// fee breakdown, and all associated payments.
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

// ═══════════════════════════════════════════════════════════════════════════════
// 7. PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/payments?period=&method=&stage=&search=&page=&limit=
// Dedicated payment ledger — one row per Payment record, plus OTC pharmacy sales.
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

// ═══════════════════════════════════════════════════════════════════════════════
// 8. LAB REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

// FIXED: `test_name` lives on LabRequestItem now, not LabRequest — both the
// search filter and the response need to go through the `items` relation.
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

// ═══════════════════════════════════════════════════════════════════════════════
// 9. LAB STATS
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// 10. LAB STOCK
// ═══════════════════════════════════════════════════════════════════════════════
//
// FIXED: LabStock's real columns are `name`, `current_stock`, `reorder_level`,
// `expiry_date` (see schema.prisma) — these functions were written against
// `item_name`, `quantity`, `reorder_at`, `expiry`, none of which exist.

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

// ═══════════════════════════════════════════════════════════════════════════════
// 11. EXPENSES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/expenses?domain=clinic|pharmacy&period=&category=
module.exports.getExpenses = async (req, res) => {
  try {
    const { domain = 'clinic', period = 'this_month', category } = req.query
    const range = getPeriodRange(period)

    const model = domain === 'pharmacy' ? prisma.pharmacyExpense : prisma.clinicExpense
    const where = { incurred_at: range }
    if (category && category !== 'all') where.category = category

    const expenses = await model.findMany({
      where,
      orderBy: { incurred_at: 'desc' },
      include: { recorded_by_staff: { select: { username: true } } },
    })

    return res.json({
      expenses: expenses.map(e => shapeExpense(e, domain)),
      stats: { total: expenses.reduce((s, e) => s + e.amount, 0) },
    })
  } catch (err) {
    console.error('[admin] getExpenses:', err.message)
    return res.status(500).json({ error: 'Failed to fetch expenses' })
  }
}

// GET /api/expenses/stats?domain=&period=
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

// POST /api/expenses  — body: { domain: 'clinic'|'pharmacy', description, amount, category?, incurred_at? }
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

// DELETE /api/expenses/:id?domain=clinic|pharmacy
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

// ═══════════════════════════════════════════════════════════════════════════════
// 12. SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.getSettings = async (req, res) => {
  try {
    const s = await getOrCreateSettings()
    return res.json({
      settings: {
        name: s.name,
        tagline: s.tagline,
        address: s.address,
        phone: s.phone,
        email: s.email,
        visit_rules: s.visit_rules ?? null,
        lab_settings: s.lab_settings ?? null,
        pharmacy_settings: s.pharmacy_settings ?? null,
        notifications: s.notifications ?? null,
        security: s.security ?? null,
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

    if (body.archive_visits_older_than_days != null) {
      const days = parseInt(body.archive_visits_older_than_days)
      if (isNaN(days) || days < 1) return res.status(400).json({ error: 'Must be a positive integer' })
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      const result = await prisma.visit.updateMany({
        where: { status: 'done', arrived_at: { lt: cutoff } },
        data: { status: 'archived' },
      })
      await writeAuditLog({ staffId, user: username, action: 'Archive Visits', description: `Archived ${result.count} visit(s) older than ${days} days`, category: 'patient', ipAddress: ip })
      return res.json({ success: true, archived: result.count })
    }

    if (body.purge_notifications_older_than_days != null) {
      const days = parseInt(body.purge_notifications_older_than_days)
      if (isNaN(days) || days < 1) return res.status(400).json({ error: 'Must be a positive integer' })
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      const result = await prisma.notification.deleteMany({ where: { timestamp: { lt: cutoff } } })
      await writeAuditLog({ staffId, user: username, action: 'Purge Notifications', description: `Deleted ${result.count} notification(s) older than ${days} days`, category: 'staff', ipAddress: ip })
      return res.json({ success: true, deleted: result.count })
    }

    const CLINIC_FIELDS = ['name', 'tagline', 'address', 'phone', 'email']
    const JSON_FIELDS = ['visit_rules', 'lab_settings', 'pharmacy_settings', 'notifications', 'security']
    const data = {}
    CLINIC_FIELDS.forEach(k => { if (k in body) data[k] = body[k] })
    JSON_FIELDS.forEach(k => { if (k in body) data[k] = body[k] })

    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields to update' })

    const settings = await getOrCreateSettings()
    // FIXED: was `prisma.settings.update` — model is `clinicSettings`.
    await prisma.clinicSettings.update({ where: { id: settings.id }, data })
    await writeAuditLog({ staffId, user: username, action: 'Settings Updated', description: `Updated: ${Object.keys(data).join(', ')}`, category: 'staff', ipAddress: ip })

    return res.json({ success: true })
  } catch (err) {
    console.error('patchSettings', err)
    return res.status(500).json({ error: 'Failed to save settings' })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════

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
 
// GET /api/admin/logs/stats
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

// ═══════════════════════════════════════════════════════════════════════════════
// 14. SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

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
  const { search } = req.query
  try {
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { generic_name: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}
    const items = await prisma.drugStock.findMany({ where, orderBy: { name: 'asc' } })
    return res.json({ items })
  } catch (error) {
    console.error('getDrugStock error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch drug stock' })
  }
}
 
// POST /api/admin/drug-stock
module.exports.createDrugStockItem = async (req, res) => {
  const {
    name, generic_name, category, form, strength,
    current_stock, unit, reorder_level,
    unit_cost, normal_price, promotional_price, wholesale_price,
    supplier, batch_number, expiry_date,
  } = req.body
 
  if (!name || !name.trim()) return res.status(400).json({ error: 'Drug name is required' })
  if (current_stock === undefined || current_stock === null) {
    return res.status(400).json({ error: 'Current stock is required' })
  }
 
  try {
    const item = await prisma.drugStock.create({
      data: {
        name: name.trim(),
        generic_name: generic_name?.trim() || '',
        category: category ?? null,
        form: form ?? null,
        strength: strength ?? null,
        current_stock: Number(current_stock),
        unit: unit || 'tablets',
        reorder_level: Number(reorder_level) || 0,
        unit_cost: Number(unit_cost) || 0,
        normal_price: Number(normal_price) || 0,
        promotional_price: Number(promotional_price) || 0,
        wholesale_price: Number(wholesale_price) || 0,
        supplier: supplier ?? null,
        batch_number: batch_number ?? null,
        expiry_date: expiry_date ? new Date(expiry_date) : null,
      },
    })
    return res.status(201).json({ message: 'Drug added', item })
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A drug with this name already exists' })
    console.error('createDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to add drug' })
  }
}
 
// PUT /api/admin/drug-stock/:id
// Edits metadata + price tiers. Does NOT touch current_stock — quantity changes
// go through the /quantity endpoint (Restock action) only.
module.exports.updateDrugStockItem = async (req, res) => {
  const { id } = req.params
  const {
    name, generic_name, category, form, strength,
    unit, reorder_level,
    unit_cost, normal_price, promotional_price, wholesale_price,
    supplier, batch_number, expiry_date,
  } = req.body
 
  if (!name || !name.trim()) return res.status(400).json({ error: 'Drug name is required' })
 
  try {
    const existing = await prisma.drugStock.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Drug not found' })
 
    const item = await prisma.drugStock.update({
      where: { id: Number(id) },
      data: {
        name: name.trim(),
        generic_name: generic_name !== undefined ? (generic_name?.trim() || '') : existing.generic_name,
        category: category ?? existing.category,
        form: form ?? existing.form,
        strength: strength ?? existing.strength,
        unit: unit ?? existing.unit,
        reorder_level: reorder_level !== undefined ? Number(reorder_level) : existing.reorder_level,
        unit_cost: unit_cost !== undefined ? Number(unit_cost) : existing.unit_cost,
        normal_price: normal_price !== undefined ? Number(normal_price) : existing.normal_price,
        promotional_price: promotional_price !== undefined ? Number(promotional_price) : existing.promotional_price,
        wholesale_price: wholesale_price !== undefined ? Number(wholesale_price) : existing.wholesale_price,
        supplier: supplier ?? existing.supplier,
        batch_number: batch_number ?? existing.batch_number,
        // NOTE: null keeps the existing date (cannot clear expiry via edit — same
        // limitation as the lab edit; change to `=== null ? null : ...` if clearing is needed)
        expiry_date: expiry_date ? new Date(expiry_date) : existing.expiry_date,
      },
    })
    return res.json({ message: 'Drug updated', item })
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A drug with this name already exists' })
    console.error('updateDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to update drug' })
  }
}
 
// PATCH /api/admin/drug-stock/:id/quantity
// ADD via { adjustment } (restock), or SET via { quantity }. Never goes negative.
module.exports.updateDrugStockQuantity = async (req, res) => {
  const { id } = req.params
  const { quantity, adjustment } = req.body
 
  try {
    const existing = await prisma.drugStock.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Drug not found' })
 
    const newQuantity = adjustment !== undefined
      ? existing.current_stock + Number(adjustment)
      : Number(quantity)
 
    if (!Number.isFinite(newQuantity) || newQuantity < 0) {
      return res.status(400).json({ error: 'Quantity cannot be negative' })
    }
 
    const item = await prisma.drugStock.update({
      where: { id: Number(id) },
      data: { current_stock: newQuantity },
    })
    return res.json({ message: 'Quantity updated', item })
  } catch (error) {
    console.error('updateDrugStockQuantity error:', error.message)
    return res.status(500).json({ error: 'Failed to update quantity' })
  }
}
 
// DELETE /api/admin/drug-stock/:id
// OtcSaleItem.drug_id is onDelete: SetNull, so this won't cascade-fail on sale history.
module.exports.deleteDrugStockItem = async (req, res) => {
  const { id } = req.params
  try {
    const existing = await prisma.drugStock.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Drug not found' })
    await prisma.drugStock.delete({ where: { id: Number(id) } })
    return res.json({ message: 'Drug deleted' })
  } catch (error) {
    console.error('deleteDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to delete drug' })
  }
}
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// CHARGE TEMPLATES  (ChargeTemplate model)
//
// One flat table. category is the ChargeCategory enum — reject anything outside it.
// The frontend aliases amount<->price; the DB column is `amount`.
// ═══════════════════════════════════════════════════════════════════════════════
 
const CHARGE_CATEGORIES = ['consultation', 'procedure', 'lab', 'medication']
 
// GET /api/admin/charge-templates
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
 
// POST /api/admin/charge-templates
module.exports.createChargeTemplate = async (req, res) => {
  const { name, category, amount, is_active } = req.body
 
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' })
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
    return res.status(201).json({ message: 'Template added', template })
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A template with this name already exists' })
    console.error('createChargeTemplate error:', error.message)
    return res.status(500).json({ error: 'Failed to add template' })
  }
}
 
// PATCH /api/admin/charge-templates/:id
module.exports.updateChargeTemplate = async (req, res) => {
  const { id } = req.params
  const { name, category, amount, is_active } = req.body
 
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
    return res.json({ message: 'Template updated', template })
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'A template with this name already exists' })
    console.error('updateChargeTemplate error:', error.message)
    return res.status(500).json({ error: 'Failed to update template' })
  }
}
 
// DELETE /api/admin/charge-templates/:id
module.exports.deleteChargeTemplate = async (req, res) => {
  const { id } = req.params
  try {
    const existing = await prisma.chargeTemplate.findUnique({ where: { id: Number(id) } })
    if (!existing) return res.status(404).json({ error: 'Template not found' })
    await prisma.chargeTemplate.delete({ where: { id: Number(id) } })
    return res.json({ message: 'Template deleted' })
  } catch (error) {
    console.error('deleteChargeTemplate error:', error.message)
    return res.status(500).json({ error: 'Failed to delete template' })
  }
}
 
 
// ═══════════════════════════════════════════════════════════════════════════════
// RESTOCK VERIFICATION  (RestockRequest model)
//
// item_id is polymorphic — points to DrugStock (department 'pharmacy') or
// LabStock (department 'lab'); there is no DB foreign key. Verify adds the
// received quantity to the correct table atomically, only from 'pending', and
// stamps who verified it from the auth token (client-supplied verified_by is
// ignored for integrity).
// ═══════════════════════════════════════════════════════════════════════════════
 
// GET /api/admin/restocks
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
 
// PATCH /api/admin/restocks/:id/verify
module.exports.verifyRestock = async (req, res) => {
  const id = Number(req.params.id)
  const { verification_notes, adjusted_qty } = req.body
  const staffId = req.user?.id
  const username = req.user?.username ?? 'Admin'
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null
 
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.restockRequest.findUnique({ where: { id } })
      if (!r) throw Object.assign(new Error('Restock request not found'), { http: 404 })
      if (r.status !== 'pending') throw Object.assign(new Error('Request already processed'), { http: 409 })
 
      const qty = adjusted_qty != null ? Number(adjusted_qty) : r.received_qty
      if (!Number.isFinite(qty) || qty < 0) throw Object.assign(new Error('Invalid quantity'), { http: 400 })
 
      if (r.department === 'pharmacy') {
        await tx.drugStock.update({ where: { id: r.item_id }, data: { current_stock: { increment: qty } } })
      } else {
        await tx.labStock.update({ where: { id: r.item_id }, data: { current_stock: { increment: qty } } })
      }
 
      return tx.restockRequest.update({
        where: { id },
        data: {
          status: 'approved',
          received_qty: qty,
          verified_by: username,
          verification_notes: verification_notes ?? null,
          verified_at: new Date(),
        },
      })
    })
 
    await writeAuditLog({
      staffId, user: username, action: 'Restock Verified',
      description: `Verified restock of ${updated.item_name} (+${updated.received_qty})`,
      category: 'restock', entity: 'RestockRequest', entityId: id, ipAddress: ip,
    })
 
    return res.json({ success: true, restock: updated })
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message })
    if (err.code === 'P2025') return res.status(409).json({ error: 'Target stock item no longer exists' })
    console.error('verifyRestock error:', err.message)
    return res.status(500).json({ error: 'Failed to verify restock' })
  }
}
 
// PATCH /api/admin/restocks/:id/reject
module.exports.rejectRestock = async (req, res) => {
  const id = Number(req.params.id)
  const { verification_notes } = req.body
  const staffId = req.user?.id
  const username = req.user?.username ?? 'Admin'
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null
 
  try {
    const r = await prisma.restockRequest.findUnique({ where: { id } })
    if (!r) return res.status(404).json({ error: 'Restock request not found' })
    if (r.status !== 'pending') return res.status(409).json({ error: 'Request already processed' })
 
    const updated = await prisma.restockRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        verified_by: username,
        verification_notes: verification_notes ?? null,
        verified_at: new Date(),
      },
    })
 
    await writeAuditLog({
      staffId, user: username, action: 'Restock Rejected',
      description: `Rejected restock of ${updated.item_name}`,
      category: 'restock', entity: 'RestockRequest', entityId: id, ipAddress: ip,
    })
 
    return res.json({ success: true, restock: updated })
  } catch (err) {
    console.error('rejectRestock error:', err.message)
    return res.status(500).json({ error: 'Failed to reject restock' })
  }
}


// REFERRALS (lReferral model)

module.exports.getReferrals = async (req, res) => {
  try {
    const rows = await prisma.Referral.findMany({
      include: {
        visit: {
          include: {
            patient: { select: { name: true } },
          },
        },
      },
      orderBy: { referred_at: 'desc' },
    })
 
    const referrals = rows.map(shapeReferral)
 
    // ── Stats ────────────────────────────────────────────────────────────────
    const pending = referrals.filter(r => r.status === 'pending')
    const paid    = referrals.filter(r => r.status === 'paid')
 
    const sum = (arr, key) => arr.reduce((acc, r) => acc + (r[key] ?? 0), 0)
 
    const stats = {
      total_referrals:      referrals.length,
      pending_count:        pending.length,
      paid_count:           paid.length,
      total_commission:     sum(referrals, 'commission_amount'),
      pending_commission:   sum(pending,   'commission_amount'),
      paid_commission:      sum(paid,      'amount_paid'),   // actual paid, not suggested
    }
 
    // ── By referrer ───────────────────────────────────────────────────────────
    // Groups referrals by referrer_name, computes per-doctor totals
    const referrerMap = {}
    for (const r of referrals) {
      const key = r.referrer_name
      if (!referrerMap[key]) {
        referrerMap[key] = {
          referrer_name:       key,
          referrer_phone:      r.referrer_phone,
          total_referrals:     0,
          total_commission:    0,
          pending_commission:  0,
          paid_commission:     0,
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
 
// ─── POST /api/admin/referrals ────────────────────────────────────────────────
// Creates a referral record. Called when reception registers a direct_lab
// visit that came via an referral.
//
// Body:
//   visit_id          Int      required
//   referrer_name     String   required
//   referrer_phone    String?
//   test_ordered      String   required  — the test name
//   test_cost         Int      required  — cost in KES
//   commission_rate   Float?   default 0.1
//   notes             String?
//   referred_at       DateTime? default now()
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
  if (!visit_id)          return res.status(400).json({ error: 'visit_id is required' })
  if (!referrer_name?.trim()) return res.status(400).json({ error: 'referrer_name is required' })
  if (!test_ordered?.trim()) return res.status(400).json({ error: 'test_ordered is required' })
  if (!test_cost || isNaN(Number(test_cost)) || Number(test_cost) <= 0) {
    return res.status(400).json({ error: 'test_cost must be a positive number' })
  }
 
  const cost   = Number(test_cost)
  const rate   = Math.min(1, Math.max(0, Number(commission_rate) || 0.1))
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
        visit_id:          Number(visit_id),
        referrer_name:     referrer_name.trim(),
        referrer_phone:    referrer_phone?.trim() ?? null,
        test_ordered:      test_ordered.trim(),
        test_cost:         cost,
        commission_rate:   rate,
        commission_amount: amount,
        notes:             notes?.trim() ?? null,
        referred_at:       referred_at ? new Date(referred_at) : new Date(),
        status:            'pending',
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
 
// ─── PATCH /api/admin/referrals/:id/pay ──────────────────────────────────────
// Marks a referral commission as paid.
//
// Body:
//   paid_by      String   required — username of admin recording the payment
//   amount_paid  Int      required — actual amount paid in KES
module.exports.payReferral = async (req, res) => {
  const referralId = Number(req.params.id)
  if (!Number.isInteger(referralId)) {
    return res.status(400).json({ error: 'Invalid referral id' })
  }
 
  const { paid_by, amount_paid } = req.body
 
  if (!paid_by?.trim()) {
    return res.status(400).json({ error: 'paid_by is required' })
  }
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
        status:      'paid',
        paid_by:     paid_by.trim(),
        amount_paid: Math.round(Number(amount_paid)),
        paid_at:     new Date(),
      },
      include: {
        visit: {
          include: {
            patient: { select: { name: true } },
          },
        },
      },
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