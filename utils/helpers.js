/**
 * server/lib/helpers.js
 *
 * Shared utilities used across all controllers.
 * Import only what you need:
 *
 *   const { getPeriodRange, requireFields, createNotification } = require('../lib/helpers')
 */

const prisma = require('../lib/prisma')

// ═══════════════════════════════════════════════════════════════════════════════
// DATE / PERIOD HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns a Prisma { gte, lte } range for a named period.
 * Used in almost every list endpoint that supports period filtering.
 *
 * @param {'today'|'this_week'|'this_month'|'this_year'|'last_30_days'} period
 */
function getPeriodRange(period) {
  const now = new Date()
  const start = new Date()
  start.setHours(0, 0, 0, 0)

  switch (period) {
    case 'today': break
    case 'this_week': start.setDate(now.getDate() - now.getDay()); break
    case 'last_30_days': start.setDate(now.getDate() - 30); break
    case 'this_year': start.setMonth(0, 1); break
    case 'this_month':
    default: start.setDate(1)
  }

  const end = new Date(now)
  end.setHours(23, 59, 59, 999)

  return { gte: start, lte: end }
}

/**
 * Midnight → 23:59:59.999 range for today only.
 */
function todayRange() {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const end = new Date(); end.setHours(23, 59, 59, 999)
  return { gte: start, lte: end }
}

/**
 * Returns an array of Date objects (midnight) for the last N calendar days.
 * Useful for building chart data.
 *
 * @param {number} n
 * @returns {Date[]}
 */
function lastNDays(n) {
  const days = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    d.setHours(0, 0, 0, 0)
    days.push(d)
  }
  return days
}

/**
 * Returns end-of-day (23:59:59.999) for a given midnight Date.
 *
 * @param {Date} dayMidnight
 * @returns {Date}
 */
function endOfDay(dayMidnight) {
  const d = new Date(dayMidnight)
  d.setHours(23, 59, 59, 999)
  return d
}

/**
 * Short human-readable day label e.g. "Mon, 2 Jun"
 *
 * @param {Date} date
 * @returns {string}
 */
function dayLabel(date) {
  return date.toLocaleDateString('en-KE', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check that required fields are present and non-empty in a request body.
 * Returns an array of missing field names, or null if all present.
 *
 * Usage:
 *   const missing = requireFields(req.body, ['name', 'amount'])
 *   if (missing) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` })
 *
 * @param {object} body
 * @param {string[]} fields
 * @returns {string[]|null}
 */
function requireFields(body, fields) {
  const missing = fields.filter((f) => {
    const val = body[f]
    return val === undefined || val === null || String(val).trim() === ''
  })
  return missing.length ? missing : null
}

function parsePositiveInt(val) {
  const n = parseInt(val)
  return (!isNaN(n) && n > 0) ? n : null
}


function parseAmount(val) {
  const n = parseFloat(val)
  return (!isNaN(n) && n >= 0) ? Math.round(n) : null
}

function parseDate(val) {
  if (!val) return null
  const d = new Date(val)
  return isNaN(d.getTime()) ? null : d
}

async function writeAuditLog({ staffId, user, action, description, category, entity, entityId, ipAddress }) {
  try {
    await prisma.auditLog.create({
      data: {
        staff_id: staffId ?? null,
        user: user ?? null,
        action,
        description,
        category,
        entity: entity ?? null,
        entity_id: entityId ?? null,
        ip_address: ipAddress ?? null,
      },
    })
  } catch (err) {
    // Log but never throw — audit failure must not affect the caller
    console.error('[auditLog] writeAuditLog failed:', err.message)
  }
}


async function createNotification({ targetRoles, targetStaffId, type, title, message, visitId, io }) {
  let notification = null

  try {
    notification = await prisma.notification.create({
      data: {
        type,
        title,
        message,
        visit_id: visitId ?? null,
        target_role: targetRoles ?? null,  // e.g. ['doctor', 'lab_tech'] or null for everyone
        target_staff_id: targetStaffId ?? null,
      },
    })
  } catch (err) {
    console.error('[notifications] createNotification failed:', err.message)
    return null
  }

  if (io && notification) {
    const payload = {
      id: notification.id,
      type,
      title,
      message,
      visit_id: visitId ?? null,
      timestamp: notification.timestamp,
    }

    try {
      if (targetStaffId) {
        // Send to a specific staff member's personal room
        io.to(`staff:${targetStaffId}`).emit('notification:new', payload)
      } else if (targetRoles && targetRoles.length > 0) {
        // Send to each role room
        targetRoles.forEach(role => io.to(role).emit('notification:new', payload))
      } else {
        // Broadcast to everyone
        io.emit('notification:new', payload)
      }
    } catch (socketErr) {
      console.error('[notifications] socket emit failed:', socketErr.message)
    }
  }

  return notification
}

async function getNextQueueNumber(tx = prisma) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const last = await tx.visit.findFirst({
    where: { arrived_at: { gte: today } },
    orderBy: { queue_number: 'desc' },
    select: { queue_number: true },
  })

  return (last?.queue_number ?? 0) + 1
}

const NOTIFICATION_TYPES = {
  NEW_PATIENT: 'patient:new',
  VISIT_FORWARDED: 'visit:forwarded',
  VISIT_COMPLETED: 'visit:completed',
  LAB_RESULTS_READY: 'lab:results_ready',
  LAB_REQUEST_NEW: 'lab:request_new',
  RX_NEW: 'rx:new',
  RX_DISPENSED: 'rx:dispensed',
  RX_RETURNED: 'rx:returned',
  RX_CANCELLED: 'rx:cancelled',
  REFERRED_PATIENT_PAID: 'payment:referred_patient_paid',
  PAYMENT_RECEIVED: 'payment:received',
  STOCK_LOW: 'stock:low',
  STOCK_OUT: 'stock:out',
  RESTOCK_REQUESTED: 'restock:requested',
  RESTOCK_APPROVED: 'restock:approved',
  RESTOCK_REJECTED: 'restock:rejected',
  ORDER_NEW: 'order_new',
  ORDER_FULFILLED: 'order_fulfilled',
  ORDER_CANCELLED: 'order_cancelled',
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a consistent 400 missing-fields error.
 *
 * Usage:
 *   const missing = requireFields(req.body, ['name'])
 *   if (missing) return missingFieldsError(res, missing)
 *
 * @param {object} res
 * @param {string[]} fields
 */
function missingFieldsError(res, fields) {
  return res.status(400).json({ error: `Missing required fields: ${fields.join(', ')}` })
}

/**
 * Send a consistent 404 not-found error.
 *
 * @param {object} res
 * @param {string} entity  e.g. 'Patient', 'Visit'
 */
function notFoundError(res, entity) {
  return res.status(404).json({ error: `${entity} not found` })
}

/**
 * Send a consistent 500 server error and log it.
 *
 * @param {object} res
 * @param {string} context  e.g. '[reception] register'
 * @param {Error}  err
 */
function serverError(res, context, err) {
  console.error(`${context}:`, err.message)
  return res.status(500).json({ error: 'Something went wrong. Please try again.' })
}



// REPORTS HELPERS 

function resolveRange(query) {
  const { range = '7d', start, end } = query
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  let rangeStart
  let rangeEnd = new Date(today)
  rangeEnd.setHours(23, 59, 59, 999)

  switch (range) {
    case 'today': {
      rangeStart = new Date(today)
      break
    }
    case '7d': {
      rangeStart = new Date(today)
      rangeStart.setDate(rangeStart.getDate() - 6)
      break
    }
    case '30d': {
      rangeStart = new Date(today)
      rangeStart.setDate(rangeStart.getDate() - 29)
      break
    }
    case 'month': {
      rangeStart = new Date(today.getFullYear(), today.getMonth(), 1)
      break
    }
    case 'custom': {
      rangeStart = new Date(start)
      rangeEnd = new Date(end)
      rangeEnd.setHours(23, 59, 59, 999)
      if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
        throw new Error('Invalid custom date range')
      }
      break
    }
    default: {
      rangeStart = new Date(today)
      rangeStart.setDate(rangeStart.getDate() - 6)
    }
  }

  const days = Math.max(
    1,
    Math.round((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24)) + 1
  )

  return { start: rangeStart, end: rangeEnd, days }
}

// Builds one bucket per day in the range, keyed by date string for O(1)
// lookups when tallying rows. Label switches from weekday ('Mon') to
// 'Mon D' once the range exceeds 7 days, so labels don't repeat/collide
// on 30-day or month views.
function buildDayBuckets(start, days) {
  const buckets = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    buckets.push({
      key: d.toDateString(),
      day:
        days <= 7
          ? d.toLocaleDateString('en-US', { weekday: 'short' })
          : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: 0,
    })
  }
  return buckets
}

function parseDateRange(from, to) {
  const fromDate = new Date(`${from}T00:00:00.000Z`)
  const toDate = new Date(`${to}T23:59:59.999Z`)
  return { fromDate, toDate }
}

function getPagination(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 10))
  const offset = (page - 1) * limit
  return { page, limit, offset }
}

function validatePaymentLines(payments, total) {
  if (!Array.isArray(payments) || payments.length === 0) {
    throw Object.assign(new Error('At least one payment line required'), { status: 400 })
  }
  const sum = payments.reduce((s, p) => s + (parseInt(p.amount) || 0), 0)
  if (sum !== total) {
    throw Object.assign(
      new Error(`Payment total (${sum}) does not match sale total (${total})`),
      { status: 400 }
    )
  }
  const hasCredit = payments.some(p => p.method === 'credit')
  return { hasCredit }
}


// 
//  RECOMPUTE BILLS 



// ─── Lock ─────────────────────────────────────────────────────────────────────

async function lockBill(tx, visitId) {
  const bill = await tx.bill.upsert({
    where: { visit_id: visitId },
    create: { visit_id: visitId },
    update: {},
    select: { id: true },
  })
  await tx.$executeRaw`SELECT id FROM bills WHERE id = ${bill.id} FOR UPDATE`
  return bill.id
}


// ─── Total ────────────────────────────────────────────────────────────────────

async function recomputeMedicationFee(tx, visitId) {
  // ── Defensive: tx must be a Prisma transaction client ──────────────────
  if (!tx || typeof tx.bill !== 'object') {
    throw new Error('recomputeMedicationFee requires a Prisma transaction client as first argument')
  }
  if (!visitId || !Number.isInteger(Number(visitId))) {
    throw new Error('recomputeMedicationFee requires a valid visitId as second argument')
  }

  // ── Lock bill row (prevents concurrent prescriptions on same visit from
  //    reading stale state and writing conflicting totals) ────────────────
  await tx.$queryRaw`SELECT id FROM bills WHERE visit_id = ${visitId} FOR UPDATE`

  // ── Read current bill (we need the other fee fields to recalc total) ───
  const bill = await tx.bill.findUnique({
    where: { visit_id: visitId },
    select: {
      id: true,
      consultation_fee: true,
      lab_fee: true,
      procedure_fee: true,
      discount_amount: true,
    },
  })

  // A visit in the pharmacy MUST have a bill. If it doesn't, the workflow
  // is broken upstream (registration didn't create a bill). We throw so the
  // transaction rolls back — stock is NOT deducted and the pharmacist sees
  // an error instead of giving away free medication.
  if (!bill) {
    throw new Error(`No bill found for visit ${visitId}. Cannot dispense without a billing record.`)
  }

  // ── Sum medication_fee from ONLY issued prescription items ─────────────
  const prescriptions = await tx.prescription.findMany({
    where: { visit_id: visitId },
    include: { items: { where: { status: 'issued' } } },
  })

  const medicationFee = prescriptions.reduce((sum, p) => {
    return sum + p.items.reduce((s, i) => s + (i.unit_cost || 0) * (i.quantity || 0), 0)
  }, 0)

  // ── Recompute total ─────────────────────────────────────────────────────
  const newTotal =
    (bill.consultation_fee || 0) +
    (bill.lab_fee || 0) +
    medicationFee +
    (bill.procedure_fee || 0) -
    (bill.discount_amount || 0)

  const safeTotal = Math.max(0, newTotal)

  // ── Atomically update both fields ──────────────────────────────────────
  await tx.bill.update({
    where: { id: bill.id },
    data: {
      medication_fee: medicationFee,
      total_amount: safeTotal,
    },
  })
}


const BILLABLE_ITEM_STATUSES = ['issued']
// ─── Medication fee ───────────────────────────────────────────────────────────

async function recomputeMedicationFee(tx, visitId) {
  if (!tx || typeof tx.bill !== 'object') {
    throw new Error('recomputeMedicationFee requires a Prisma transaction client')
  }
  if (!visitId || !Number.isInteger(Number(visitId))) {
    throw new Error('recomputeMedicationFee requires a valid visitId')
  }

  await tx.$queryRaw`SELECT id FROM bills WHERE visit_id = ${visitId} FOR UPDATE`

  const bill = await tx.bill.findUnique({
    where: { visit_id: visitId },
    select: {
      id: true,
      consultation_fee: true,
      lab_fee: true,
      procedure_fee: true,
      discount_amount: true,
    },
  })

  if (!bill) {
    throw new Error(`No bill found for visit ${visitId}`)
  }

  const prescriptions = await tx.prescription.findMany({
    where: { visit_id: visitId },
    include: { items: { where: { status: 'issued' } } },
  })

  const medicationFee = prescriptions.reduce((sum, p) => {
    return sum + p.items.reduce((s, i) => s + i.unit_cost * i.quantity, 0)
  }, 0)

  const newTotal =
    bill.consultation_fee +
    bill.lab_fee +
    medicationFee +
    bill.procedure_fee -
    bill.discount_amount

  await tx.bill.update({
    where: { id: bill.id },
    data: {
      medication_fee: medicationFee,
      total_amount: Math.max(0, newTotal),
    },
  })
}



// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Date helpers
  getPeriodRange,
  todayRange,
  lastNDays,
  endOfDay,
  dayLabel,

  // Validation
  requireFields,
  parsePositiveInt,
  parseAmount,
  parseDate,

  // Audit log
  writeAuditLog,

  // Notifications
  createNotification,
  NOTIFICATION_TYPES,

  // Queue
  getNextQueueNumber,

  // Response shortcuts
  missingFieldsError,
  notFoundError,
  serverError,
  resolveRange,
  buildDayBuckets,
  parseDateRange,
  getPagination,
  validatePaymentLines,

  lockBill,
  recomputeMedicationFee,
  BILLABLE_ITEM_STATUSES
}