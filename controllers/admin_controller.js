const bcrypt = require('bcryptjs')
const prisma = require('../lib/prisma')
const { takeStock, giveStock } = require('./pharmacy_controller')
const { writeAuditLog, getPeriodRange, todayRange, lastNDays, endOfDay, dayLabel, buildDayBuckets, resolveRange, parseDateRange, getPagination, createNotification, NOTIFICATION_TYPES } = require('../utils/helpers')
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

function lockCustomer(tx, customerId) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK.CUSTOMER}::int, ${customerId}::int)`
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
    commission_amount: r.commission_amount ?? 0,
    amount_paid: r.status === 'paid' ? (r.amount_paid ?? 0) : 0,
  }
}


const LOCK = { PRODUCT: 1, CUSTOMER: 2 }

function lockProduct(tx, productId) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK.PRODUCT}::int, ${productId}::int)`
}


module.exports.getAdminOverview = async (req, res) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  try {
    const [
      pipelineGroups,
      visitCount,
      paymentsByStage,
      openBills,
      activeStaff,
      activeDoctorVisits,
      lowDrugs,
      lowReagents,
      recentPayments,
      recentVisits,
      recentExpenses,
    ] = await Promise.all([
      // Counted in the database, not by loading every visit into memory.
      prisma.visit.groupBy({
        by: ['status'],
        where: { arrived_at: { gte: today } },
        _count: { _all: true },
      }),
      prisma.visit.count({ where: { arrived_at: { gte: today } } }),

      prisma.payment.groupBy({
        by: ['stage'],
        where: { paid_at: { gte: today } },
        _sum: { amount: true },
      }),

      // Outstanding debt is billed − discount − paid, per bill. Summing
      // total_amount on pending bills counts a half-paid bill in full, and
      // total_amount itself is stale on most rows.
      prisma.bill.findMany({
        where: { visit: { status: { in: ['done', 'partially_paid', 'archived'] } } },
        select: {
          consultation_fee: true, lab_fee: true,
          medication_fee: true, procedure_fee: true,
          discount_amount: true,
          payments: { select: { amount: true } },
        },
      }),

      prisma.staff.findMany({
        where: { is_active: true, role: { not: 'admin' } },
        select: { id: true, username: true, role: true },
        orderBy: { role: 'asc' },
      }),

      prisma.visit.groupBy({
        by: ['doctor_id'],
        where: { arrived_at: { gte: today }, status: 'with_doctor', doctor_id: { not: null } },
        _count: { _all: true },
      }),

      // Filter in SQL — the old version pulled every product and every lab
      // stock row to compare two columns.
      prisma.$queryRaw`
        SELECT id, name, current_stock, reorder_level, unit
        FROM products
        WHERE is_active = true AND current_stock <= reorder_level
        ORDER BY current_stock ASC
        LIMIT 5
      `,
      prisma.$queryRaw`
        SELECT id, name, current_stock, reorder_level, unit
        FROM lab_stock
        WHERE current_stock <= reorder_level
        ORDER BY current_stock ASC
        LIMIT 5
      `,

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
        select: {
          id: true, description: true, amount: true, created_at: true,
          recorded_by_staff: { select: { username: true } },
        },
      }),
    ])

    // ── Pipeline ──────────────────────────────────────────────────────────
    const counts = Object.fromEntries(pipelineGroups.map((g) => [g.status, g._count._all]))
    const pipeline = {
      waiting: counts.waiting ?? 0,
      consultation_paid: counts.consultation_paid ?? 0,
      with_doctor: counts.with_doctor ?? 0,
      lab: counts.lab ?? 0,
      pharmacy: counts.pharmacy ?? 0,
      billing: counts.billing ?? 0,
      partially_paid: counts.partially_paid ?? 0,
      done: counts.done ?? 0,
    }

    // ── Money ─────────────────────────────────────────────────────────────
    const byStage = Object.fromEntries(paymentsByStage.map((g) => [g.stage, g._sum.amount ?? 0]))
    const stage1 = byStage[1] ?? 0
    const stage2 = byStage[2] ?? 0

    let pendingAmount = 0
    let pendingCount = 0
    for (const b of openBills) {
      const billed = b.consultation_fee + b.lab_fee + b.medication_fee + b.procedure_fee
      const paid = b.payments.reduce((s, p) => s + p.amount, 0)
      const owed = billed - b.discount_amount - paid
      if (owed > 0) {
        pendingAmount += owed
        pendingCount++
      }
    }

    // ── Staff ─────────────────────────────────────────────────────────────
    const activeByDoctor = Object.fromEntries(
      activeDoctorVisits.map((g) => [g.doctor_id, g._count._all])
    )
    const staffOnDuty = activeStaff.map((s) => ({
      id: s.id,
      username: s.username,
      role: s.role,
      active_visits: activeByDoctor[s.id] ?? 0,
    }))

    // ── Stock ─────────────────────────────────────────────────────────────
    const withAlert = (rows) =>
      rows.map((r) => ({
        ...r,
        alert: r.current_stock === 0 ? 'out_of_stock' : 'low_stock',
      }))

    // ── Activity feed ─────────────────────────────────────────────────────
    const activityEvents = []

    recentPayments.forEach((p) => {
      activityEvents.push({
        id: `pay-${p.id}`,
        category: 'payment',
        description: `${p.bill?.visit?.patient?.name ?? 'Unknown patient'} paid KES ${p.amount.toLocaleString()} — ${p.stage === 1 ? 'consultation fee' : 'final bill'}`,
        user: p.cashier?.username ?? 'Cashier',
        timestamp: p.paid_at,
      })
    })

    recentVisits.forEach((v) => {
      activityEvents.push({
        id: `visit-${v.id}`,
        category: 'patient',
        description: `${v.patient?.name ?? 'Patient'} registered — ${v.visit_type.replace(/_/g, ' ')}`,
        user: 'Reception',
        timestamp: v.arrived_at,
      })
    })

    recentExpenses.forEach((e) => {
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
        patients_today: visitCount,
        revenue_today: stage1 + stage2,
        stage1_collected: stage1,
        stage2_collected: stage2,
        // Outstanding across all finished visits, not just today — labelled
        // as such on the card so it isn't read as a daily figure.
        pending_payments: pendingCount,
        pending_amount: pendingAmount,
        staff_on_duty: staffOnDuty.length,
      },
      pipeline,
      staff_on_duty: staffOnDuty,
      recent_activity: recentActivity,
      low_stock: { drugs: withAlert(lowDrugs), reagents: withAlert(lowReagents) },
    })
  } catch (err) {
    console.error('getAdminOverview error:', err.message)
    return res.status(500).json({ error: 'Failed to load overview' })
  }
}


module.exports.getPharmacyFinanceOverview = async (req, res) => {
  try {
    const { from, to } = req.query

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' })
    }

    const start = new Date(from)
    const end = new Date(to)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' })
    }
    if (start > end) {
      return res.status(400).json({ error: 'from must be before to' })
    }

    start.setHours(0, 0, 0, 0)
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + 1) // exclusive upper bound

    const range = { gte: start, lt: end }
    const n = (v) => v ?? 0

    const [
      salePayments,
      debtCollected,
      salesAgg,
      discountAgg,
      expenseAgg,
      returnsAgg,
      creditEverExtended,
      creditEverCollected,
    ] = await prisma.$transaction([
      // Cash-equivalent settlement at the till, by method.
      prisma.otcSalePayment.groupBy({
        by: ['method'],
        where: { created_at: range, method: { not: 'credit' } },
        _sum: { amount: true },
      }),

      // Debt repayments — where credit sales finally become revenue. Credit
      // notes are excluded: a return reduces debt without money arriving.
      prisma.customerPayment.aggregate({
        where: { created_at: range, is_credit_note: false },
        _sum: { amount: true },
      }),

      // Accrual: goods sold in the period, regardless of settlement.
      prisma.otcSale.aggregate({
        where: { sold_at: range },
        _sum: { total: true },
        _count: true,
      }),

      prisma.otcSale.aggregate({
        where: { sold_at: range },
        _sum: { discount_amount: true },
      }),

      prisma.pharmacyExpense.groupBy({
        by: ['category'],
        where: { incurred_at: range },
        _sum: { amount: true },
      }),

      // Refunds land on the day of the return, not the day of the original
      // sale — restating a past day would change a figure already reported.
      prisma.otcSaleReturn.aggregate({
        where: { created_at: range },
        _sum: { cash_refund_amount: true, credit_note_amount: true },
      }),

      // Receivable position as of the range end — a balance, not a flow.
      prisma.otcSalePayment.aggregate({
        where: { method: 'credit', created_at: { lt: end } },
        _sum: { amount: true },
      }),
      prisma.customerPayment.aggregate({
        where: { created_at: { lt: end } },
        _sum: { amount: true },
      }),
    ])

    // ── Revenue: till receipts + debt repayments − cash refunded ──
    const by_method = { cash: 0, mpesa: 0, insurance: 0, other: 0 }
    let tillRevenue = 0
    for (const p of salePayments) {
      by_method[p.method] = n(p._sum.amount)
      tillRevenue += n(p._sum.amount)
    }

    const debt_collected = n(debtCollected._sum.amount)

    // A credit note moves no money — it only reduces what the customer owes,
    // so it never touches revenue. Only cash out of the drawer does.
    const cashRefunded = n(returnsAgg._sum.cash_refund_amount)
    const creditNoted = n(returnsAgg._sum.credit_note_amount)

    const total_revenue = tillRevenue + debt_collected - cashRefunded

    // ── Credit extended in the period, reported separately from revenue ──
    const total_sales = n(salesAgg._sum.total)
    const credit_extended = Math.max(0, total_sales - tillRevenue)

    // ── Expenses ──
    let total_expenses = 0
    const by_category = {}
    for (const e of expenseAgg) {
      const cat = e.category?.trim() || 'uncategorized'
      by_category[cat] = (by_category[cat] || 0) + n(e._sum.amount)
      total_expenses += n(e._sum.amount)
    }

    const total_credit = n(creditEverExtended._sum.amount)
    const total_collected = n(creditEverCollected._sum.amount)

    const days_in_range = Math.round((end - start) / 86400000)

    return res.json({
      revenue: {
        total: total_revenue,
        till: tillRevenue,
        debt_collected,
        refunded: cashRefunded,
      },
      sales: {
        total: total_sales,
        count: salesAgg._count,
        credit_extended,
        discounts: n(discountAgg._sum.discount_amount),
        returns_cash: cashRefunded,
        returns_credit_note: creditNoted,
        // What the period actually kept, after goods came back.
        net_sales: Math.max(0, total_sales - cashRefunded - creditNoted),
      },
      by_payment_method: by_method, // credit excluded by design
      expenses: {
        total: total_expenses,
        by_category,
      },
      outstanding: {
        total_credit,
        total_collected,
        balance: Math.max(0, total_credit - total_collected),
        as_of: new Date(end.getTime() - 1),
      },
      days_in_range,
      net: total_revenue - total_expenses,
    })
  } catch (err) {
    console.error('Pharmacy finance overview error:', err.message)
    return res.status(500).json({ error: 'Failed to load pharmacy finance overview' })
  }
}
module.exports.getPharmacySales = async (req, res) => {
  try {
    const {
      from,
      to,
      search,
      payment_method,
      page = '1',
      limit = '20',
    } = req.query

    const start = from ? new Date(from) : new Date()
    const end = to ? new Date(to) : new Date()
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' })
    }
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)

    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20))
    const skip = (pageNum - 1) * limitNum

    const where = { sold_at: { gte: start, lte: end } }

    // Filter on the payment lines, not OtcSale.payment_method — that scalar
    // reads 'credit' for any split sale containing a credit portion.
    if (payment_method && payment_method !== 'all') {
      where.payments = { some: { method: payment_method } }
    }

    if (search?.trim()) {
      const q = search.trim()
      where.OR = [
        { receipt_number: { contains: q, mode: 'insensitive' } },
        { customer_name: { contains: q, mode: 'insensitive' } },
      ]
    }

    const [sales, total] = await Promise.all([
      prisma.otcSale.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { sold_at: 'desc' },
        include: {
          items: {
            select: {
              id: true,
              name: true,
              quantity: true,
              unit_price: true,
              unit_cost: true,
              tax_amount: true,
              price_tier: true,
              product_batch_id: true,
            },
          },
          payments: {
            select: {
              id: true,
              method: true,
              amount: true,
              reference: true,
              created_at: true,
            },
          },
          customer: {
            select: { id: true, name: true, phone: true },
          },
          sold_by_staff: {
            select: { username: true },
          },
          // Needed so the return modal can cap each line's stepper at what is
          // actually left to return.
          returns: { include: { items: true } },
        },
      }),
      prisma.otcSale.count({ where }),
    ])

    const shaped = sales.map((s) => {
      // How much of each line has already come back. Derived from the return
      // rows — sale items are never mutated when goods are returned.
      const returnedByItem = new Map()
      for (const r of s.returns ?? []) {
        for (const ri of r.items ?? []) {
          returnedByItem.set(
            ri.sale_item_id,
            (returnedByItem.get(ri.sale_item_id) || 0) + ri.quantity
          )
        }
      }

      return {
        id: s.id,
        receipt_number: s.receipt_number,
        customer_name: s.customer_name,
        customer_id: s.customer_id,
        subtotal: s.subtotal,
        tax_total: s.tax_total,
        total: s.total,
        discount_amount: s.discount_amount,
        discount_reason: s.discount_reason,
        payment_method: s.payment_method,
        // True settlement mix. The scalar above is a display fallback only.
        methods: [...new Set((s.payments || []).map((p) => p.method))],
        is_split: (s.payments || []).length > 1,
        sold_at: s.sold_at,
        sold_by: s.sold_by_staff?.username ?? null,
        items: s.items.map((it) => {
          const returned = returnedByItem.get(it.id) || 0
          return {
            ...it,
            returned_qty: returned,
            returnable_qty: it.quantity - returned,
          }
        }),
        payments: s.payments,
        returns: (s.returns ?? []).map((r) => ({
          id: r.id,
          return_number: r.return_number,
          cash_refund_amount: r.cash_refund_amount,
          credit_note_amount: r.credit_note_amount,
          refund_amount: r.cash_refund_amount + r.credit_note_amount,
          reason: r.reason,
          returned_by: r.returned_by,
          created_at: r.created_at,
        })),
      }
    })

    return res.json({
      sales: shaped,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    })
  } catch (err) {
    console.error('getPharmacySales error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch pharmacy sales' })
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

    const [labRequests, items, completed] = await Promise.all([
      prisma.labRequest.findMany({
        where,
        select: { id: true, requested_at: true },
      }),
      prisma.labRequestItem.findMany({
        where: { lab_request: where },
        select: { test_name: true, catalog_id: true },
      }),
      prisma.labRequest.findMany({
        where: { completed_at: { gte: start, lte: end } },
        select: { requested_at: true, completed_at: true },
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

    const byCatalog = new Map()
    const byName = new Map()

    for (const item of items) {
      if (item.catalog_id != null) {
        byCatalog.set(item.catalog_id, (byCatalog.get(item.catalog_id) || 0) + 1)
      } else if (item.test_name) {
        const key = item.test_name.trim().toLowerCase()
        const prev = byName.get(key)
        byName.set(key, { name: prev?.name ?? item.test_name.trim(), count: (prev?.count || 0) + 1 })
      }
    }

    // Resolve to the current catalogue name.
    const catalogNames = byCatalog.size
      ? await prisma.labTestCatalog.findMany({
        where: { id: { in: [...byCatalog.keys()] } },
        select: { id: true, name: true },
      })
      : []
    const nameById = new Map(catalogNames.map((t) => [t.id, t.name]))

    const top_tests = [
      ...[...byCatalog.entries()].map(([id, count]) => ({
        name: nameById.get(id) ?? `Test #${id}`,
        catalog_id: id,
        count,
      })),
      ...[...byName.values()].map((v) => ({ ...v, catalog_id: null })),
    ]
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
    const { start, end, days } = resolveRange(req.query)
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
    const by_visit_type = byTypeGroups.reduce((acc, g) => {
      acc[g.visit_type] = g._count._all
      return acc
    }, {})

    const most_common_type = byTypeGroups
      .slice()
      .sort((a, b) => b._count._all - a._count._all)[0]?.visit_type ?? '—'

    const dayBuckets = buildDayBuckets(start, days)
    const bucketByKey = Object.fromEntries(dayBuckets.map((b) => [b.key, b]))
    for (const v of visits) {
      const key = new Date(v.arrived_at).toDateString()
      if (bucketByKey[key]) bucketByKey[key].count++
    }
    const by_day = dayBuckets.map(({ day, count }) => ({ day, count }))

    const avg_per_day = days > 0 ? Math.round(total_visits / days) : 0

    const completedCount = visits.filter((v) =>
      ['done', 'archived', 'partially_paid'].includes(v.status)
    ).length
    const completion_rate =
      total_visits > 0 ? Math.round((completedCount / total_visits) * 100) : 0

    return res.json({
      stats: { total_visits, avg_per_day, most_common_type, completion_rate },
      by_day,
      by_visit_type,
    })
  } catch (err) {
    console.error('[admin] getAdminVisitsReport:', err.message)
    if (err.message === 'Invalid custom date range') {
      return res.status(400).json({ error: 'Invalid start/end date' })
    }
    return res.status(500).json({ error: 'Failed to fetch visit report' })
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
            select: { drug_name: true, quantity: true, status: true, product_id: true },
          },
        },
      }),
      prisma.otcSale.findMany({
        where: { sold_at: { gte: start, lte: end } },
        select: {
          id: true,
          sold_at: true,
          items: { select: { name: true, quantity: true, product_id: true } },
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

    // ── top_drugs ────────────────────────────────────────────────────────
    // Keyed on product_id so a prescription line and an OTC line for the same
    // product merge. drug_name and OtcSaleItem.name are free-text snapshots —
    // grouping on them splits one product across every spelling ever used.
    const byProduct = new Map()   // product_id -> units
    const byName = new Map()      // fallback for unlinked lines

    const add = (productId, name, qty) => {
      if (productId != null) {
        byProduct.set(productId, (byProduct.get(productId) || 0) + qty)
      } else if (name) {
        const key = name.trim().toLowerCase()
        byName.set(key, { name: name.trim(), count: (byName.get(key)?.count || 0) + qty })
      }
    }

    for (const rx of dispensedPrescriptions) {
      for (const item of rx.items) {
        if (item.status !== 'issued') continue
        add(item.product_id, item.drug_name, item.quantity || 0)
      }
    }
    for (const sale of otcSales) {
      for (const item of sale.items) {
        add(item.product_id, item.name, item.quantity || 0)
      }
    }

    // Resolve linked products to their current catalogue name.
    const productNames = byProduct.size
      ? await prisma.product.findMany({
        where: { id: { in: [...byProduct.keys()] } },
        select: { id: true, name: true },
      })
      : []
    const nameById = new Map(productNames.map((p) => [p.id, p.name]))

    const top_drugs = [
      ...[...byProduct.entries()].map(([id, count]) => ({
        name: nameById.get(id) ?? `Product #${id}`,
        product_id: id,
        count,
      })),
      ...[...byName.values()].map((v) => ({ ...v, product_id: null })),
    ]
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
    const visitWhere = {
      arrived_at: { gte: periodStart },
      status: { in: ['done', 'partially_paid', 'archived'] },
    }
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
    console.error('getPatients error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch patients' })
  }
}

module.exports.getPatientStats = async (req, res) => {
  const { period = 'this_month' } = req.query
  const periodStart = getPeriodStart(period)

  try {
    const [totalPatients, billAgg, topDiagnosis, pendingAgg] = await Promise.all([
      prisma.patient.count({
        where: { visits: { some: { arrived_at: { gte: periodStart }, status: { in: ['done', 'partially_paid', 'archived'] } } } },
      }),
      prisma.bill.aggregate({
        where: { visit: { arrived_at: { gte: periodStart }, status: { in: ['done', 'partially_paid', 'archived'] } } },
        _sum: { total_amount: true },
      }),
      prisma.visit.groupBy({
        by: ['diagnosis'],
        where: { arrived_at: { gte: periodStart }, diagnosis: { not: null }, status: { in: ['done', 'partially_paid', 'archived'] } },
        _count: { diagnosis: true },
        orderBy: { _count: { diagnosis: 'desc' } },
        take: 1,
      }),
      prisma.bill.aggregate({
        where: { visit: { arrived_at: { gte: periodStart }, status: { in: ['done', 'partially_paid', 'archived'] } } },
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
    console.error('getPatientStats:', err.message)
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
    const total_discounts = patient.visits.reduce((s, v) => s + num(v.bill?.discount_amount), 0)
    const total_paid = patient.visits.reduce(
      (s, v) => s + (v.bill?.payments?.reduce((a, p) => a + p.amount, 0) ?? 0),
      0
    )
    const unpaid_balance = Math.max(0, total_billed - total_paid - total_discounts)

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
          consultation_fee_waived_by: bill.consultation_fee_waived_by,
          consultation_fee_waive_reason: bill.consultation_fee_waive_reason,
          consultation_fee_waived_at: bill.consultation_fee_waived_at,
          lab_fee: bill.lab_fee,
          medication_fee: bill.medication_fee,
          procedure_fee: bill.procedure_fee,
          stage2_status: bill.stage2_status,
          stage2_waived_by: bill.stage2_waived_by,
          stage2_waive_reason: bill.stage2_waive_reason,
          stage2_waived_at: bill.stage2_waived_at,
          discount_amount: bill.discount_amount,
          discount_reason: bill.discount_reason,
          total_amount: bill.total_amount,
          fee_status: bill.fee_status,
          paid_amount,
          balance: Math.max(0, bill.total_amount - paid_amount - (bill.discount_amount || 0)),
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
    console.error('getPatientDetail error:', err.message)
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
    await writeAuditLog({
      staffId: req.user?.id,
      user: req.user?.username,
      action: 'Staff Created',
      description: `Created ${staff.role} account "${staff.username}"`,
      category: 'staff',
      entity: 'Staff',
      entityId: staff.id,
      ipAddress: req.ip,
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
    if (Number(id) === req.user?.id) {
      return res.status(400).json({ error: 'You cannot change your own account status' })
    }
    const staff = await prisma.staff.findUnique({ where: { id: Number(id) } })
    if (!staff) return res.status(404).json({ error: 'Staff not found' })

    const updatedStaff = await prisma.staff.update({
      where: { id: Number(id) },
      data: { is_active: !staff.is_active },
    })
    await writeAuditLog({
      staffId: req.user?.id,
      user: req.user?.username,
      action: staff.is_active ? 'Staff Deactivated' : 'Staff Activated',
      description: `${staff.is_active ? 'Deactivated' : 'Activated'} "${staff.username}" (${staff.role})`,
      category: 'staff',
      entity: 'Staff',
      entityId: staff.id,
      ipAddress: req.ip,
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
    const user = await prisma.staff.findUnique({ where: { id: Number(id) } })
    if (!user) return res.status(404).json({ error: 'Staff not found' })
    await prisma.staff.update({
      where: { id: Number(id) },
      data: { password: hashed },
    })
    await writeAuditLog({
      staffId: req.user?.id,
      user: req.user?.username,
      action: 'Password Reset',
      description: `Reset password for "${user.username}" (${user.role})`,
      category: 'staff',
      entity: 'Staff',
      entityId: id,
      ipAddress: req.ip,
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
          select: { method: true, amount: true }
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
      from,
      to,
      status,
      visit_type,
      search,
      page = '1',
      limit = '20',
    } = req.query

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to dates are required' })
    }

    const { fromDate, toDate } = parseDateRange(from, to)

    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20))
    const skip = (pageNum - 1) * limitNum

    // One nested `visit` object — assigning it twice drops the first constraint.
    const visitWhere = { status: { in: ['billing', 'done', 'archived', 'partially_paid'] } }
    if (visit_type && visit_type !== 'all') visitWhere.visit_type = visit_type
    if (search?.trim()) {
      visitWhere.patient = { name: { contains: search.trim(), mode: 'insensitive' } }
    }

    const where = {
      created_at: { gte: fromDate, lte: toDate },
      visit: visitWhere,
    }

    // 'partial' is derived, not stored, so it can't be a database filter.
    // Everything else maps straight onto fee_status.
    if (status && status !== 'all' && status !== 'partial') {
      where.fee_status = status
    }

    const [rows, total] = await Promise.all([
      prisma.bill.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { created_at: 'desc' },
        include: {
          visit: {
            select: {
              id: true,
              visit_type: true,
              status: true,
              arrived_at: true,
              patient: { select: { id: true, name: true, phone: true, gender: true } },
              doctor: { select: { username: true } },
            },
          },
          payments: {
            orderBy: { paid_at: 'asc' },
            select: {
              id: true, amount: true, method: true, reference: true,
              stage: true, paid_at: true,
              cashier: { select: { username: true } },
            },
          },
        },
      }),
      prisma.bill.count({ where }),
    ])

    const shaped = rows.map((b) => {
      const billed =
        b.consultation_fee + b.lab_fee + b.medication_fee + b.procedure_fee
      const paid_amount = b.payments.reduce((s, p) => s + p.amount, 0)
      const outstanding_amount = Math.max(0, billed - paid_amount - b.discount_amount)

      // Display only. fee_status stays a closed/open flag in the database.
      const display_status =
        outstanding_amount === 0 ? b.fee_status
          : paid_amount > 0 ? 'partial'
            : 'pending'

      const items = [
        b.consultation_fee > 0 && { name: 'Consultation', amount: b.consultation_fee, status: b.consultation_fee_status },
        b.lab_fee > 0 && { name: 'Lab Tests', amount: b.lab_fee, status: b.stage2_status },
        b.medication_fee > 0 && { name: 'Medication', amount: b.medication_fee, status: b.stage2_status },
        b.procedure_fee > 0 && { name: 'Procedure', amount: b.procedure_fee, status: b.stage2_status },
      ].filter(Boolean)

      return {
        id: b.id,
        visit_id: b.visit_id,
        patient_id: b.visit?.patient?.id ?? null,
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

        total_amount: billed,
        paid_amount,
        discount_amount: b.discount_amount,
        discount_reason: b.discount_reason ?? null,
        outstanding_amount,
        fee_status: b.fee_status,
        status: display_status,

        items,
        payments: b.payments.map((p) => ({
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

    // Filtered in memory because 'partial' has no column. Applied after the
    // page is fetched, so `total` still reflects the unfiltered set — the
    // page may come back short. Acceptable for a display-only filter.
    const bills =
      status === 'partial'
        ? shaped.filter((b) => b.status === 'partial')
        : shaped

    // Summary covers the whole filtered set, not the page. Aggregates rather
    // than a third findMany over every matching bill.
    const [feeAgg, paidAgg, waivedAgg, statusCounts] = await Promise.all([
      prisma.bill.aggregate({
        where,
        _sum: {
          consultation_fee: true, lab_fee: true,
          medication_fee: true, procedure_fee: true,
          discount_amount: true,
        },
      }),
      prisma.payment.aggregate({
        where: { bill: where },
        _sum: { amount: true },
      }),
      prisma.bill.aggregate({
        where: { ...where, fee_status: 'waived' },
        _sum: { discount_amount: true },
        _count: true,
      }),
      prisma.bill.groupBy({
        by: ['fee_status'],
        where,
        _count: { _all: true },
      }),
    ])

    const n = (v) => v ?? 0
    const total_billed =
      n(feeAgg._sum.consultation_fee) + n(feeAgg._sum.lab_fee) +
      n(feeAgg._sum.medication_fee) + n(feeAgg._sum.procedure_fee)
    const total_collected = n(paidAgg._sum.amount)
    const total_discount = n(feeAgg._sum.discount_amount)

    const counts = Object.fromEntries(
      statusCounts.map((g) => [g.fee_status, g._count._all])
    )

    return res.json({
      bills,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      summary: {
        total_billed,
        total_collected,
        total_discount,
        // Set-wide residual. Individual overpayments aren't clamped away here,
        // so this can differ slightly from the sum of per-bill balances.
        total_outstanding: Math.max(0, total_billed - total_collected - total_discount),
        total_waived: n(waivedAgg._sum.discount_amount),
        paid_count: counts.paid ?? 0,
        pending_count: counts.pending ?? 0,
        waived_count: waivedAgg._count ?? 0,
      },
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

    await writeAuditLog({
      staffId: req.user?.id,
      user: req.user?.username,
      action: 'Lab Stock Adjusted',
      description:
        `${existing.name}: ${existing.current_stock} → ${newQuantity} ${existing.unit}` +
        (adjustment !== undefined ? ` (adjustment ${adjustment > 0 ? '+' : ''}${adjustment})` : ' (set directly)'),
      category: 'stock',
      entity: 'LabStock',
      entityId: Number(id),
      ipAddress: req.ip ?? null,
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

    const FIELDS = ['name', 'tagline', 'address', 'phone', 'email', 'pharmacy_settings']
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


module.exports.getPharmacyStock = async (req, res) => {
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

exports.getProductDetail = async (req, res) => {
  try {
    const id = req.params.id

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        batches: {
          orderBy: [{ is_exhausted: 'asc' }, { received_at: 'desc' }],
        },
        _count: {
          select: { movements: true },
        },
      },
    })

    if (!product) {
      return res.status(404).json({ error: 'Product not found' })
    }

    res.json({
      product,
      batches: product.batches,
      stats: {
        total_movements: product._count.movements,
      },
    })
  } catch (err) {
    console.error('getProductDetail', err)
    res.status(500).json({ error: 'Failed to fetch product details' })
  }
}

// ─── GET /api/admin/products/:id/movements ───────────────────────────────────

exports.getProductMovements = async (req, res) => {
  try {
    const id = req.params.id
    const {
      reason,
      batch_id,
      from,
      to,
      page = '1',
      limit = '25',
    } = req.query

    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 25))
    const skip = (pageNum - 1) * limitNum

    const where = { product_id: id }

    if (reason) {
      where.reason = reason
    }

    if (batch_id) {
      const bid = parseInt(batch_id)
      if (!isNaN(bid)) where.batch_id = bid
    }

    if (from || to) {
      const range = {}
      if (from) range.gte = new Date(from)
      if (to) {
        const end = new Date(to)
        end.setDate(end.getDate() + 1)
        range.lt = end
      }
      where.created_at = range
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          batch: { select: { batch_number: true } },
          staff: { select: { username: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.stockMovement.count({ where }),
    ])

    res.json({ movements, total })
  } catch (err) {
    console.error('getProductMovements', err)
    res.status(500).json({ error: 'Failed to fetch stock movements' })
  }
}


module.exports.deletePharmacyStockItem = async (req, res) => {
  const id = Number(req.params.id)
  try {
    const product = await prisma.product.findUnique({
      where: { id },
      select: { name: true, is_active: true, current_stock: true },
    })
    if (!product) return res.status(404).json({ error: 'Item not found' })
    if (!product.is_active) return res.status(409).json({ error: `${product.name} is already deactivated` })
    if (product.current_stock > 0) {
      return res.status(409).json({
        error: `${product.name} still has ${product.current_stock} in stock — clear it before deactivating`,
      })
    }

    const { count } = await prisma.product.updateMany({
      where: { id, is_active: true, current_stock: 0 },
      data: { is_active: false },
    })
    if (count === 0) return res.status(409).json({ error: 'Stock changed while deactivating — reload and try again' })

    await writeAuditLog({
      staffId: req.user?.id,
      user: req.user?.username,
      action: 'Product Deactivated',
      description: `Deactivated "${product.name}"`,
      category: 'stock',
      entity: 'Product',
      entityId: id,
      ipAddress: req.ip ?? null,
    })
    return res.json({ success: true })
  } catch (error) {
    console.error('deleteDrugStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to deactivate item' })
  }
}
module.exports.createStockItem = async (req, res) => {
  const {
    name, generic_name, category, sub_category, form, strength,
    current_stock, unit, reorder_level,
    normal_price, promotional_price, wholesale_price,
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
          normal_price: Number(normal_price) || 0,
          promotional_price: Number(promotional_price) || 0,
          wholesale_price: Number(wholesale_price) || 0,
          supplier: supplier ?? null,
        },
      })

      if (Number(current_stock) > 0) {
        const batch = await tx.productBatch.create({
          data: {
            product_id: item.id,
            quantity: Number(current_stock),
            received_by: req.user?.username ?? null,
            expiry_date: expiry_date ? new Date(expiry_date) : null,
          },
        })

        await tx.stockMovement.create({
          data: {
            product_id: item.id,
            batch_id: batch.id,
            delta: Number(current_stock),
            reason: 'restock',
            ref_type: 'product_creation',
            ref_id: batch.id,
            balance_after: Number(current_stock),
            staff_id: req.user?.id ?? null,
            note: 'Initial stock',
          },
        })
      }


      return item
    })
    await writeAuditLog({
      staffId: req.user?.id,
      user: req.user?.username,
      action: 'Stock Added',
      description:
        `Created ${result.name} (#${result.id}) with opening stock ` +
        `${result.current_stock} ${result.unit}` +
        (expiry_date ? `, expires ${expiry_date}` : ', no expiry recorded'),
      category: 'stock',
      entity: 'Product',
      entityId: result.id,
      ipAddress: req.ip ?? null,
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

module.exports.updateStockItemQuantity = async (req, res) => {
  const id = Number(req.params.id)
  const { quantity, adjustment, expiry_date, note } = req.body
  const currentUser = req.user
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid product id' })
  }

  const qty = adjustment !== undefined ? Number(adjustment) : Number(quantity)
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be a positive whole number' })
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
    const result = await prisma.$transaction(async (tx) => {
      await lockProduct(tx, id)

      const product = await tx.product.findUnique({
        where: { id },
        select: { id: true, name: true, unit: true, current_stock: true },
      })
      if (!product) throw Object.assign(new Error('Item not found'), { http: 404 })

      const updated = await tx.product.update({
        where: { id },
        data: { current_stock: { increment: qty } },
        select: { current_stock: true },
      })

      const batch = await tx.productBatch.create({
        data: {
          product_id: id,
          quantity: qty,
          expiry_date: expiry,
          received_by: currentUser?.username ?? null,
          notes: (typeof note === 'string' && note.trim()) || null,
        },
      })

      await tx.stockMovement.create({
        data: {
          product_id: id,
          batch_id: batch.id,
          delta: qty,
          reason: 'restock',
          ref_type: 'manual_restock',
          ref_id: batch.id,
          balance_after: updated.current_stock,
          staff_id: currentUser?.id ?? null,
          note: expiry
            && `expires ${expiry.toISOString().slice(0, 10)}`
        },
      })

      return { product, balance: updated.current_stock }
    })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'Stock Added',
      description:
        `Added ${qty} ${result.product.unit} of ${result.product.name} ` +
        `new balance ${result.balance}` +
        (expiry ? `, expires ${expiry.toISOString().slice(0, 10)}` : ', no expiry recorded'),
      category: 'stock',
      entity: 'Product',
      entityId: id,
      ipAddress: ip,
    })

    const item = await prisma.product.findUnique({
      where: { id },
      include: { batches: { where: { is_exhausted: false }, orderBy: { expiry_date: 'asc' } } },
    })

    return res.json({ message: 'Stock added', item })
  } catch (error) {
    if (error.http) return res.status(error.http).json({ error: error.message })
    console.error('updateStockItemQuantity error:', error.message)
    return res.status(500).json({ error: 'Failed to add stock' })
  }
}

module.exports.deleteLabStockItem = async (req, res) => {
  const id = Number(req.params.id)
  const currentUser = req.user

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid lab stock id' })
  }

  try {
    const existing = await prisma.labStock.findUnique({
      where: { id },
      select: { id: true, name: true, current_stock: true, unit: true, is_active: true },
    })
    if (!existing) return res.status(404).json({ error: 'Stock item not found' })
    if (!existing.is_active) {
      return res.status(409).json({ error: `${existing.name} is already retired` })
    }
    if (existing.current_stock > 0) {
      return res.status(409).json({
        error:
          `${existing.name} still has ${existing.current_stock} ${existing.unit} in stock — ` +
          `write it down before retiring it`,
      })
    }

    await prisma.labStock.update({ where: { id }, data: { is_active: false } })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'Lab Stock Retired',
      description: `Retired ${existing.name} (#${id})`,
      category: 'stock',
      entity: 'LabStock',
      entityId: id,
      ipAddress: req.ip ?? null,
    })

    return res.json({ message: 'Stock item retired' })
  } catch (error) {
    console.error('deleteLabStockItem error:', error.message)
    return res.status(500).json({ error: 'Failed to retire item' })
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
      entityId: template.id,
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
    const { status, department, page = '1', limit = '50' } = req.query

    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50))
    const skip = (pageNum - 1) * limitNum

    const where = {}
    if (status && status !== 'all') where.status = status
    if (department && department !== 'all') where.department = department

    const [rows, total, statusCounts] = await Promise.all([
      prisma.restockRequest.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { requested_at: 'desc' },
        include: {
          product: {
            select: { id: true, name: true, unit: true, current_stock: true, category: true, normal_price: true },
          },
          lab_stock: {
            select: { id: true, name: true, unit: true, current_stock: true, category: true, unit_cost: true },
          },
        },
      }),
      prisma.restockRequest.count({ where }),
      prisma.restockRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ])

    const restocks = rows.map((r) => {
      const stock = r.product ?? r.lab_stock ?? null
      // Products carry a selling price, lab stock a unit cost. Neither is a
      // true purchase cost, so this is indicative only.
      const unitValue = r.product?.normal_price ?? r.lab_stock?.unit_cost ?? 0

      return {
        id: r.id,
        department: r.department,
        product_id: r.product_id,
        lab_stock_id: r.lab_stock_id,
        item_name: stock?.name ?? null,
        unit: stock?.unit ?? null,
        category: stock?.category ?? null,
        current_stock: stock?.current_stock ?? null,
        quantity: r.quantity,
        estimated_value: unitValue * r.quantity,
        batch_number: r.batch_number ?? null,
        expiry_date: r.expiry_date ?? null,
        notes: r.notes ?? null,
        status: r.status,
        requested_by: r.requested_by,
        requested_at: r.requested_at,
        verified_by: r.verified_by ?? null,
        verified_at: r.verified_at ?? null,
        verification_notes: r.verification_notes ?? null,
      }
    })

    const counts = Object.fromEntries(statusCounts.map((g) => [g.status, g._count._all]))

    // Value of everything still awaiting approval — computed over all pending
    // requests, not just the current page.
    const pendingRows = await prisma.restockRequest.findMany({
      where: { status: 'pending' },
      select: {
        quantity: true,
        product: { select: { normal_price: true } },
        lab_stock: { select: { unit_cost: true } },
      },
    })
    const pendingValue = pendingRows.reduce(
      (s, r) => s + (r.product?.normal_price ?? r.lab_stock?.unit_cost ?? 0) * r.quantity,
      0
    )

    return res.json({
      restocks,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      stats: {
        pending: counts.pending ?? 0,
        approved: counts.approved ?? 0,
        rejected: counts.rejected ?? 0,
        pending_value: pendingValue,
      },
    })
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
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.restockRequest.findUnique({ where: { id } })
      if (!r) throw Object.assign(new Error('Restock request not found'), { http: 404 })
      if (r.status !== 'pending')
        throw Object.assign(new Error('Request already processed'), { http: 409 })

      const qty = adjusted_qty != null ? Number(adjusted_qty) : r.quantity
      if (!Number.isFinite(qty) || qty < 0)
        throw Object.assign(new Error('Invalid quantity'), { http: 400 })

      if (r.department === 'pharmacy') {
        if (!r.product_id)
          throw Object.assign(new Error('Restock request has no linked product'), { http: 422 })

        await lockProduct(tx, r.product_id)

        const product = await tx.product.findUnique({
          where: { id: r.product_id },
        })
        if (!product)
          throw Object.assign(new Error('Product no longer exists in the catalog'), { http: 404 })

        const finalExpiry = expiry_date ? new Date(expiry_date) : r.expiry_date

        await tx.product.update({
          where: { id: product.id },
          data: { current_stock: { increment: qty } },
        })

        const batch = await tx.productBatch.create({
          data: {
            product_id: product.id,
            expiry_date: finalExpiry,
            quantity: qty,
            received_by: currentUser.username,
            notes: verification_notes ?? null,
          },
        })

        await tx.stockMovement.create({
          data: {
            product_id: product.id,
            batch_id: batch.id,
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

      const request = await tx.restockRequest.update({
        where: { id },
        data: {
          status: 'approved',
          quantity: qty,
          verified_by: currentUser.username,
          verification_notes: verification_notes ?? null,
          verified_at: new Date(),
        },
        include: {
          product: { select: { name: true, unit: true } },
          lab_stock: { select: { name: true, unit: true } },
        },
      })

      return { request, qty, requestedQty: r.quantity }
    })

    const { request: updatedRequest, qty: approvedQty, requestedQty } = result
    const stock = updatedRequest.product ?? updatedRequest.lab_stock

    await writeAuditLog({
      staffId: currentUser.id,
      user: currentUser.username,
      action: 'Restock Verified',
      description:
        `Verified restock of ${stock?.name ?? `request #${id}`} ` +
        `(+${approvedQty} ${stock?.unit ?? 'units'})` +
        (approvedQty !== requestedQty ? ` — requested ${requestedQty}` : ''),
      category: 'restock',
      entity: 'RestockRequest',
      entityId: id,
      ipAddress: ip,
    })

    return res.json({ success: true, restock: updatedRequest })
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
    const rows = await prisma.referral.findMany({
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
    const existing = await prisma.referral.findUnique({
      where: { visit_id: Number(visit_id) },
    })
    if (existing) {
      return res.status(409).json({ error: 'A referral already exists for this visit' })
    }

    const referral = await prisma.referral.create({
      data: {
        visit_id: Number(visit_id),
        referrer_name: referrer_name.trim(),
        referrer_phone: referrer_phone?.trim() ?? null,
        commission_amount: amount,
        notes: notes?.trim() ?? null,
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
    const referral = await prisma.referral.findUnique({
      where: { id: referralId },
    })

    if (!referral) {
      return res.status(404).json({ error: 'Referral not found' })
    }
    if (referral.status === 'paid') {
      return res.status(409).json({ error: 'This referral has already been marked as paid' })
    }

    const updated = await prisma.referral.update({
      where: { id: referralId },
      data: {
        status: 'paid',
        amount_paid: amount_paid,
        paid_at: new Date(),
        paid_by: currentUser.username,
        commission_amount: Math.round(Number(amount_paid)),
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
      description: `commision paid for visit ${updated.visit.id}, amount ${updated.amount_paid}`,
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
      return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' })
    }

    const start = new Date(from)
    const end = new Date(to)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' })
    }
    if (start > end) {
      return res.status(400).json({ error: 'from must be before to' })
    }

    start.setHours(0, 0, 0, 0)
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + 1) // exclusive upper bound

    const range = { gte: start, lt: end }
    const n = (v) => v ?? 0

    const FINISHED = ['partially_paid', 'done', 'archived']

    const [byMethod, collected, billedAgg, clinicExp, referralsTotal, clinicCat, openBills] =
      await prisma.$transaction([
        // ── Cash collected in range, split by method ──
        prisma.payment.groupBy({
          by: ['method'],
          where: { paid_at: range },
          _sum: { amount: true },
        }),

        // ── Cash collected in range, total. This is revenue. ──
        prisma.payment.aggregate({
          where: { paid_at: range },
          _sum: { amount: true },
        }),

        // ── Accrued: what was charged in range, for visits that reached billing ──
        prisma.bill.aggregate({
          where: { created_at: range, visit: { status: { in: FINISHED } } },
          _sum: {
            consultation_fee: true,
            lab_fee: true,
            medication_fee: true,
            procedure_fee: true,
            discount_amount: true,
          },
        }),

        prisma.clinicExpense.aggregate({
          where: { incurred_at: range },
          _sum: { amount: true },
        }),

        prisma.referral.aggregate({
          where: { status: 'paid', paid_at: range },
          _sum: { commission_amount: true },
        }),

        prisma.clinicExpense.groupBy({
          by: ['category'],
          where: { incurred_at: range },
          _sum: { amount: true },
        }),

        prisma.bill.findMany({
          where: { created_at: { lt: end }, fee_status: 'pending', visit: { status: { in: FINISHED } } },
          select: {
            consultation_fee: true,
            lab_fee: true,
            medication_fee: true,
            procedure_fee: true,
            discount_amount: true,
            payments: { select: { amount: true } },
          },
        }),
      ])

    // ── Revenue: cash that actually arrived. Partials included by construction. ──
    const totalRevenue = n(collected._sum.amount)

    const byPaymentMethod = { cash: 0, mpesa: 0, insurance: 0, credit: 0, other: 0 }
    for (const p of byMethod) byPaymentMethod[p.method] = n(p._sum.amount)

    // ── Billed: derived from the fee columns, not Bill.total_amount,
    //    which no code path reliably maintains. ──
    const consultation = n(billedAgg._sum.consultation_fee)
    const lab = n(billedAgg._sum.lab_fee)
    const medication = n(billedAgg._sum.medication_fee)
    const procedures = n(billedAgg._sum.procedure_fee)
    const totalDiscount = n(billedAgg._sum.discount_amount)
    const totalBilled = consultation + lab + medication + procedures

    // ── Credit: per-bill so an overpayment can't offset another patient's debt ──
    let totalCredit = 0
    for (const b of openBills) {
      const billed =
        b.consultation_fee + b.lab_fee + b.medication_fee + b.procedure_fee
      const paid = b.payments.reduce((s, p) => s + p.amount, 0)
      totalCredit += Math.max(0, billed - b.discount_amount - paid)
    }

    const clinicTotal = n(clinicExp._sum.amount)
    const referrals = n(referralsTotal._sum.commission_amount)
    const totalExpenses = clinicTotal + referrals

    const byCategory = {}
    for (const r of clinicCat) {
      const key = r.category?.trim() || 'uncategorized'
      byCategory[key] = (byCategory[key] || 0) + n(r._sum.amount)
    }

    const daysInRange = Math.round((end - start) / 86400000)

    return res.json({
      revenue: {
        total: totalRevenue,
      },
      billed: {
        total: totalBilled,
        consultation,
        lab,
        medication,
        procedures,
        discounts: totalDiscount,
      },
      outstanding: {
        total: totalCredit,
        as_of: new Date(end.getTime() - 1),
      },
      by_payment_method: byPaymentMethod,
      expenses: {
        total: totalExpenses,
        by_department: { reception: clinicTotal, referrals },
        by_category: byCategory,
      },
      days_in_range: daysInRange,
      net: totalRevenue - totalExpenses,
    })
  } catch (err) {
    console.error('Finance overview error:', err.message)
    res.status(500).json({ error: 'Failed to load finance overview' })
  }
}

// ─── 2. Outstanding Balances ─────────────────────────────────────────────────

// GET /api/admin/outstanding-balances
module.exports.getOutstandingBalances = async (req, res) => {
  try {
    const { from, to, source } = req.query

    if (source === 'pharmacy') {
      return res.status(400).json({
        error: 'Pharmacy credit is served by /api/admin/pharmacy/debt-book',
      })
    }

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to dates are required' })
    }

    const { fromDate, toDate } = parseDateRange(from, to)
    const { page, limit, offset } = getPagination(req)

    // Window functions carry the set-wide count and total alongside the page,
    // so the caller gets accurate totals without a second pass over the data.
    const rows = await prisma.$queryRaw`
      WITH bill_balances AS (
        SELECT
          b.visit_id,
          p.id    AS patient_id,
          p.name  AS patient_name,
          p.phone AS patient_phone,
          (b.consultation_fee + b.lab_fee + b.medication_fee + b.procedure_fee)::int AS total_bill,
          COALESCE(SUM(py.amount), 0)::int AS paid_amount,
          b.discount_amount::int AS waived_amount,
          v.arrived_at AS created_at
        FROM bills b
        JOIN visits v   ON v.id = b.visit_id
        JOIN patients p ON p.id = v.patient_id
        LEFT JOIN payments py ON py.bill_id = b.id
        WHERE b.created_at >= ${fromDate}
          AND b.created_at <= ${toDate}
          AND v.status IN ('done', 'archived', 'partially_paid')
        GROUP BY
          b.id, b.visit_id, b.consultation_fee, b.lab_fee,
          b.medication_fee, b.procedure_fee, b.discount_amount,
          v.id, v.arrived_at, p.id, p.name, p.phone
      )
      SELECT
        visit_id,
        patient_id,
        patient_name,
        patient_phone,
        total_bill,
        paid_amount,
        waived_amount,
        (total_bill - paid_amount - waived_amount)::int AS balance,
        created_at,
        COUNT(*) OVER ()::int AS result_count,
        COALESCE(SUM(total_bill - paid_amount - waived_amount) OVER (), 0)::int AS result_total
      FROM bill_balances
      WHERE total_bill - paid_amount - waived_amount > 0
      ORDER BY balance DESC, visit_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `

    const total = rows[0]?.result_count ?? 0
    const totalOutstanding = rows[0]?.result_total ?? 0

    const outstanding = rows.map((r) => ({
      source: 'clinic',
      entity_id: r.visit_id,
      patient_id: r.patient_id,
      patient_name: r.patient_name,
      patient_phone: r.patient_phone,
      total_bill: r.total_bill,
      paid_amount: r.paid_amount,
      waived_amount: r.waived_amount,
      balance: r.balance,
      created_at: r.created_at,
    }))

    return res.json({
      outstanding,
      total_outstanding: totalOutstanding,
      count: total,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    })
  } catch (err) {
    console.error('getOutstandingBalances error:', err.message)
    return res.status(500).json({ error: 'Failed to load outstanding balances' })
  }
}

// PATCH /api/admin/outstanding-balances/:id
module.exports.updateOutstandingBalance = async (req, res) => {
  try {
    const { action, amount, method, reference, reason } = req.body
    const visitId = Number(req.params.visitId)
    if (!Number.isInteger(visitId)) {
      return res.status(400).json({ error: 'Invalid visit id' })
    }
    if (!['settle', 'waive'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' })
    }

    const currentUser = req.user
    const ip = req.ip ?? req.headers['x-forwarded-for'] ?? null

    const result = await prisma.$transaction(async (tx) => {
      const httpError = (message, status = 400) =>
        Object.assign(new Error(message), { status })

      const existing = await tx.bill.findUnique({
        where: { visit_id: visitId },
        select: { id: true },
      })
      if (!existing) throw httpError('Bill not found', 404)

      // Lock before reading the balance, or two cashiers both pass the guard.
      await tx.$executeRaw`SELECT id FROM bills WHERE id = ${existing.id} FOR UPDATE`

      const bill = await tx.bill.findUnique({
        where: { id: existing.id },
        include: {
          payments: { select: { amount: true } },
          visit: { include: { patient: { select: { id: true, name: true, phone: true } } } },
        },
      })

      // Billed comes from the fee columns. Bill.total_amount is stale.
      const billed =
        bill.consultation_fee + bill.lab_fee + bill.medication_fee + bill.procedure_fee
      const paidAmount = bill.payments.reduce((s, p) => s + p.amount, 0)
      const balance = Math.max(0, billed - paidAmount - bill.discount_amount)

      if (balance <= 0) throw httpError('This bill has no outstanding balance', 409)

      if (action === 'settle') {
        const amt = Number(amount)
        if (!Number.isInteger(amt) || amt <= 0) {
          throw httpError('Amount must be a positive whole number')
        }
        if (amt > balance) {
          throw httpError(`Amount exceeds balance of ${balance}`, 400)
        }

        await tx.payment.create({
          data: {
            bill_id: bill.id,
            amount: amt,
            method: method || 'cash',
            reference: reference?.trim() || null,
            stage: 2,
            cashier_id: currentUser?.id ?? null,
          },
        })

        const newPaid = paidAmount + amt
        const newBalance = billed - newPaid - bill.discount_amount

        if (newBalance <= 0) {
          await tx.bill.update({
            where: { id: bill.id },
            data: { stage2_status: 'paid', stage2_paid_at: new Date(), fee_status: 'paid' },
          })
          await tx.visit.update({ where: { id: visitId }, data: { status: 'done' } })
        }

        return {
          action: 'settle',
          amount: amt,
          bill,
          billed,
          paid: newPaid,
          waived: bill.discount_amount,
          balance: Math.max(0, newBalance),
        }
      }

      // waive
      if (!reason?.trim()) throw httpError('Reason is required for a waiver')

      const requested = Number(amount)
      const waiveAmt =
        Number.isInteger(requested) && requested > 0 && requested < balance
          ? requested
          : balance

      const newDiscount = bill.discount_amount + waiveAmt
      const newBalance = billed - paidAmount - newDiscount

      await tx.bill.update({
        where: { id: bill.id },
        data: {
          discount_amount: newDiscount,
          discount_reason: reason.trim(),
          ...(newBalance <= 0 && {
            stage2_status: 'waived',
            stage2_waived_at: new Date(),
            stage2_waived_by: currentUser?.username ?? 'unknown',
            stage2_waive_reason: reason.trim(),
            // 'paid' when cash was collected, 'waived' when nothing was.
            fee_status: paidAmount > 0 ? 'paid' : 'waived',
          }),
        },
      })

      if (newBalance <= 0) {
        await tx.visit.update({ where: { id: visitId }, data: { status: 'done' } })
      }

      return {
        action: 'waive',
        amount: waiveAmt,
        bill,
        billed,
        paid: paidAmount,
        waived: newDiscount,
        balance: Math.max(0, newBalance),
      }
    })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: result.action === 'settle' ? 'Debt Settled' : 'Balance Waived',
      description:
        `${result.action === 'settle' ? 'Collected' : 'Waived'} ${result.amount} ` +
        `for ${result.bill.visit.patient.name} — visit #${visitId}, ` +
        `remaining ${result.balance}` +
        (result.action === 'waive' ? ` — reason: ${reason.trim()}` : ''),
      category: 'payment',
      entity: 'Bill',
      entityId: result.bill.id,
      ipAddress: ip,
    })

    return res.json({
      row: {
        source: 'clinic',
        entity_id: visitId,
        patient_id: result.bill.visit.patient.id,
        patient_name: result.bill.visit.patient.name,
        patient_phone: result.bill.visit.patient.phone,
        total_bill: result.billed,
        paid_amount: result.paid,
        waived_amount: result.waived,
        balance: result.balance,
      },
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.meta })
    console.error('Update outstanding error:', err)
    res.status(500).json({ error: 'Failed to update balance' })
  }
}

exports.getDebtBook = async (req, res) => {
  try {
    const [creditRows, paymentRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT s.customer_id, SUM(sp.amount)::int AS total_credit
        FROM otc_sale_payments sp
        JOIN otc_sales s ON s.id = sp.sale_id
        WHERE sp.method = 'credit' AND s.customer_id IS NOT NULL
        GROUP BY s.customer_id
      `,
      prisma.customerPayment.groupBy({
        by: ['customer_id'],
        _sum: { amount: true },
      }),
    ])

    const paidByCustomer = new Map(
      paymentRows.map((p) => [p.customer_id, p._sum.amount ?? 0])
    )

    const owing = creditRows
      .map((r) => ({
        customer_id: r.customer_id,
        total_credit: r.total_credit,
        total_paid: paidByCustomer.get(r.customer_id) ?? 0,
      }))
      .map((r) => ({ ...r, balance: r.total_credit - r.total_paid }))
      .filter((r) => r.balance > 0)

    if (owing.length === 0) {
      return res.json({ debtors: [], stats: { count: 0, total_outstanding: 0 } })
    }

    const customers = await prisma.pharmacyCustomer.findMany({
      where: { id: { in: owing.map((r) => r.customer_id) } },
      select: { id: true, name: true, phone: true },
    })
    const byId = new Map(customers.map((c) => [c.id, c]))

    const lastSales = await prisma.otcSale.groupBy({
      by: ['customer_id'],
      where: { customer_id: { in: owing.map((r) => r.customer_id) } },
      _max: { sold_at: true },
    })
    const lastSaleByCustomer = new Map(
      lastSales.map((s) => [s.customer_id, s._max.sold_at])
    )

    const debtors = owing
      .map((r) => ({
        id: r.customer_id,
        name: byId.get(r.customer_id)?.name ?? 'Unknown',
        phone: byId.get(r.customer_id)?.phone ?? null,
        total_credit: r.total_credit,
        total_paid: r.total_paid,
        balance: r.balance,
        last_sale: lastSaleByCustomer.get(r.customer_id) ?? null,
      }))
      .sort((a, b) => b.balance - a.balance)

    return res.json({
      debtors,
      stats: {
        count: debtors.length,
        total_outstanding: debtors.reduce((s, d) => s + d.balance, 0),
      },
    })
  } catch (err) {
    console.error('getDebtBook', err.message)
    return res.status(500).json({ error: 'Failed to load debt book' })
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
      await lockCustomer(tx, customerId)
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

// ─── Stocktake review ────────────────────────────────────────────────────────

module.exports.approveStocktake = async (req, res) => {
  const id = Number(req.params.id)
  const currentUser = req.user
  const { review_notes } = req.body || {}
  const notes = (typeof review_notes === 'string' && review_notes.trim()) || null

  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Session ID is required' })

  try {
    const result = await prisma.$transaction(async (tx) => {
      const now = new Date()

      // The status change is the first write, not a check followed by one. A
      // second approval blocks on this row, then matches nothing.
      const claim = await tx.stocktakeSession.updateMany({
        where: { id, status: 'submitted' },
        data: {
          status: 'approved',
          reviewed_by: currentUser?.username ?? null,
          reviewed_by_id: currentUser?.id ?? null,
          reviewed_at: now,
          review_notes: notes,
        },
      })
      if (claim.count === 0) {
        const existing = await tx.stocktakeSession.findUnique({
          where: { id },
          select: { status: true },
        })
        if (!existing) throw Object.assign(new Error('Stocktake not found'), { http: 404 })
        throw Object.assign(
          new Error(`Only a submitted stocktake can be approved — this one is ${existing.status.replace('_', ' ')}`),
          { http: 409 }
        )
      }

      const session = await tx.stocktakeSession.findUnique({
        where: { id },
        select: {
          label: true,
          items: {
            where: { counted_at: { not: null } },
            select: {
              id: true, product_id: true, variance: true, reason: true, posted_at: true,
              product: { select: { name: true, unit: true } },
            },
            // Consistent lock order. Two transactions taking product locks in
            // opposite orders deadlock.
            orderBy: { product_id: 'asc' },
          },
        },
      })

      const failures = []
      const resolved = []
      let postedCount = 0
      let missing = 0
      let found = 0

      for (const item of session.items) {
        // Adjusted on an earlier pass, or nothing to adjust.
        if (item.posted_at != null || item.variance === 0) {
          resolved.push(item.product_id)
          continue
        }

        await lockProduct(tx, item.product_id)

        const common = {
          productId: item.product_id,
          reason: 'stocktake',
          refType: 'stocktake_item',
          refId: item.id,
          staffId: currentUser?.id,
          note: `Stocktake "${session.label}"${item.reason ? ` — ${item.reason}` : ''}`,
        }

        if (item.variance < 0) {
          const qty = -item.variance

          // takeStock throws — rather than returning null — at two points that
          // come after it has already decremented the product. A throw here
          // would roll back every line posted so far, so the shortfall is
          // checked under the lock and takeStock is never asked to fail.
          const [product, live] = await Promise.all([
            tx.product.findUnique({
              where: { id: item.product_id },
              select: { current_stock: true },
            }),
            tx.productBatch.aggregate({
              where: { product_id: item.product_id, is_exhausted: false, quantity: { gt: 0 } },
              _sum: { quantity: true },
            }),
          ])
          const onHand = Math.min(product?.current_stock ?? 0, live._sum.quantity ?? 0)

          if (onHand < qty) {
            failures.push({
              item_id: item.id,
              product_id: item.product_id,
              product: item.product.name,
              variance: item.variance,
              available: onHand,
              reason: `Only ${onHand} ${item.product.unit ?? 'unit(s)'} on hand — ${qty} needed to post this shortfall`,
            })
            continue
          }

          const out = await takeStock(tx, { ...common, quantity: qty })
          if (out === null) {
            failures.push({
              item_id: item.id,
              product_id: item.product_id,
              product: item.product.name,
              variance: item.variance,
              available: onHand,
              reason: 'Stock moved while the adjustment was being posted',
            })
            continue
          }
          missing += item.variance
        } else {
          await giveStock(tx, { ...common, quantity: item.variance, batch_id: null })
          found += item.variance
        }

        await tx.stocktakeItem.update({ where: { id: item.id }, data: { posted_at: now } })
        postedCount++
        resolved.push(item.product_id)
      }

      // Products still in dispute stay unstamped, so the rotation brings them
      // round first rather than treating them as freshly verified.
      if (resolved.length) {
        await tx.product.updateMany({
          where: { id: { in: resolved } },
          data: { last_counted_at: now },
        })
      }

      if (failures.length) {
        const summary =
          `${failures.length} line(s) returned for recount — ` +
          `${failures.map((f) => f.product).join(', ')}. ` +
          `The other ${postedCount} adjustment(s) were posted and will not be posted again.`
        await tx.stocktakeSession.update({
          where: { id },
          data: {
            status: 'in_progress',
            submitted_by: null,
            submitted_at: null,
            review_notes: notes ? `${notes} — ${summary}` : summary,
          },
        })
      }

      const uncounted = await tx.stocktakeItem.count({
        where: { session_id: id, counted_at: null },
      })

      return { label: session.label, postedCount, missing, found, uncounted, failures }
    }, { timeout: 30000 })

    const partial = result.failures.length > 0

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: partial ? 'Stocktake Partially Approved' : 'Stocktake Approved',
      description:
        `${partial ? 'Partially approved' : 'Approved'} "${result.label}" — ` +
        `${result.postedCount} adjustment(s) posted, ${Math.abs(result.missing)} unit(s) written off, ` +
        `${result.found} found, ${result.uncounted} left uncounted` +
        (partial
          ? `. Returned for recount: ${result.failures.map((f) => `${f.product} (${f.variance})`).join(', ')}`
          : ''),
      category: 'stock',
      entity: 'StocktakeSession',
      entityId: id,
      ipAddress: req.ip ?? null,
    })

    await createNotification({
      targetRoles: ['pharmacist'],
      type: partial ? NOTIFICATION_TYPES.STOCKTAKE_RETURNED : NOTIFICATION_TYPES.STOCKTAKE_APPROVED,
      title: partial ? 'Stocktake partly approved' : 'Stocktake approved',
      message: partial
        ? `"${result.label}" — ${result.postedCount} adjustment(s) posted. ${result.failures.length} line(s) need a recount: ${result.failures.map((f) => f.product).join(', ')}.`
        : `"${result.label}" was approved — ${result.postedCount} stock adjustment(s) posted.`,
    })

    return res.json({
      success: true,
      partial,
      status: partial ? 'in_progress' : 'approved',
      posted_count: result.postedCount,
      failures: result.failures,
    })
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message, ...(err.meta ?? {}) })
    console.error('approveStocktake', err.message)
    return res.status(500).json({ error: 'Failed to approve stocktake' })
  }
}

module.exports.rejectStocktake = async (req, res) => {
  const id = Number(req.params.id)
  const currentUser = req.user
  const { review_notes } = req.body || {}

  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Session ID is required' })
  if (!review_notes || !String(review_notes).trim()) {
    return res.status(400).json({ error: 'A note is required when returning a stocktake' })
  }

  try {
    const session = await prisma.stocktakeSession.findUnique({ where: { id } })
    if (!session) return res.status(404).json({ error: 'Stocktake not found' })

    // Conditional write, not a check. A concurrent approve or return matches
    // nothing here rather than both proceeding.
    const { count } = await prisma.stocktakeSession.updateMany({
      where: { id, status: 'submitted' },
      data: {
        status: 'in_progress',
        review_notes: String(review_notes).trim(),
        reviewed_by: currentUser?.username ?? null,
        reviewed_by_id: currentUser?.id ?? null,
        reviewed_at: new Date(),
        submitted_by: null,
        submitted_at: null,
      },
    })
    if (count === 0) {
      const fresh = await prisma.stocktakeSession.findUnique({
        where: { id },
        select: { status: true },
      })
      return res.status(409).json({
        error: `Only a submitted stocktake can be returned — this one is ${(fresh?.status ?? 'gone').replace('_', ' ')}`,
      })
    }

    await createNotification({
      targetRoles: ['pharmacist'],
      type: NOTIFICATION_TYPES.STOCKTAKE_RETURNED,
      title: 'Stocktake returned',
      message: `"${session.label}" was returned for correction: ${String(review_notes).trim()}`,
    })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'Stocktake Returned',
      description: `Returned "${session.label}" for correction — ${String(review_notes).trim()}`,
      category: 'stock',
      entity: 'StocktakeSession',
      entityId: id,
      ipAddress: req.ip ?? null,
    })

    return res.json({ success: true })
  } catch (err) {
    console.error('rejectStocktake', err.message)
    return res.status(500).json({ error: 'Failed to return stocktake' })
  }
}