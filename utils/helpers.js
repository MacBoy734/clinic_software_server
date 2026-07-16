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

/**
 * Parse and validate a positive integer from a string.
 * Returns the number, or null if invalid.
 *
 * @param {any} val
 * @returns {number|null}
 */
function parsePositiveInt(val) {
  const n = parseInt(val)
  return (!isNaN(n) && n > 0) ? n : null
}

/**
 * Parse and validate a non-negative number (amount, quantity etc).
 * Returns the number, or null if invalid.
 *
 * @param {any} val
 * @returns {number|null}
 */
function parseAmount(val) {
  const n = parseFloat(val)
  return (!isNaN(n) && n >= 0) ? Math.round(n) : null
}

/**
 * Safely parse a date string. Returns a Date object or null.
 *
 * @param {any} val
 * @returns {Date|null}
 */
function parseDate(val) {
  if (!val) return null
  const d = new Date(val)
  return isNaN(d.getTime()) ? null : d
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Write an audit log entry. Never throws — errors are swallowed so a
 * logging failure never crashes a request.
 *
 * @param {{ staffId?, user?, action, description, category, entity?, entityId?, ipAddress? }} params
 */
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

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a DB notification. Never throws.
 * Optionally pass `io` to also push via WebSocket immediately.
 *
 * Usage:
 *   await createNotification({
 *     role:     'doctor',
 *     type:     'info',
 *     message:  'New patient ready for consultation',
 *     entity:   'visit',
 *     entityId: visit.id,
 *     io,       // optional — pass your socket.io instance for real-time push
 *   })
 *
 * @param {{ staffId?, role?, type, message, entity?, entityId?, io? }} params
 */
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

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUE NUMBER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate the next queue number for today.
 * Finds the highest queue_number among today's visits and increments by 1.
 * Call this inside a transaction when registering a new visit.
 *
 * @param {object} tx  — Prisma transaction client (or prisma directly)
 * @returns {Promise<number>}
 */
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
}