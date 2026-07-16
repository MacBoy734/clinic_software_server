const prisma = require('../lib/prisma')
const { getPeriodRange } = require('../utils/helpers')

// ─── Domain/role authorization ───────────────────────────────────────────────
//
// Each role is allowed to touch exactly one expense domain.
// `domain` from the query/body is only ever used to CONFIRM the request
// matches what the role is allowed to do — it is never trusted blindly.
// This closes the gap where a receptionist could pass ?domain=pharmacy
// and read/write pharmacy expenses they have no business touching.

// receptionist/pharmacist are locked to exactly one domain each.
// admin is handled separately below — it can access either domain, or both.
const ROLE_TO_DOMAIN = {
  receptionist: 'clinic',
  pharmacist: 'pharmacy',
}

const MODELS = {
  clinic: prisma.clinicExpense,
  pharmacy: prisma.pharmacyExpense,
}

// Returns one of:
//   { domain: 'clinic'|'pharmacy', model }   — single-domain access (locked role, or admin with ?domain=)
//   { combined: true, models: [...] }        — admin with no domain specified, spans both tables
//   { mismatch: true, allowedDomain, requestedDomain } — locked role tried to access the other domain
//   { invalidDomain: true, requestedDomain } — admin passed a domain that doesn't exist
//   null                                     — role has no expense access at all (doctor, lab_tech)
function resolveDomain(req) {
  const role = req.user.role
  const requestedDomain = req.query?.domain || req.body?.domain

  // Admin — full oversight. Explicit domain narrows to one table;
  // no domain means "give me both, combined".
  if (role === 'admin') {
    if (requestedDomain) {
      if (!MODELS[requestedDomain]) {
        return { invalidDomain: true, requestedDomain }
      }
      return { domain: requestedDomain, model: MODELS[requestedDomain] }
    }
    return {
      combined: true,
      models: [
        { domain: 'clinic', model: MODELS.clinic },
        { domain: 'pharmacy', model: MODELS.pharmacy },
      ],
    }
  }

  // Locked roles — receptionist/pharmacist only ever see their own domain.
  const allowedDomain = ROLE_TO_DOMAIN[role]
  if (!allowedDomain) return null // e.g. doctor, lab_tech — no expense access

  if (requestedDomain && requestedDomain !== allowedDomain) {
    return { mismatch: true, allowedDomain, requestedDomain }
  }

  return { domain: allowedDomain, model: MODELS[allowedDomain] }
}

function domainErrorResponse(res, resolved) {
  if (!resolved) {
    return res.status(403).json({ error: 'Your role does not have access to expenses' })
  }
  if (resolved.mismatch) {
    return res.status(403).json({
      error: `Your role can only access '${resolved.allowedDomain}' expenses, not '${resolved.requestedDomain}'`,
    })
  }
  if (resolved.invalidDomain) {
    return res.status(400).json({
      error: `'${resolved.requestedDomain}' is not a valid expense domain. Use 'clinic' or 'pharmacy'.`,
    })
  }
  return null
}

// Write operations (create/update/delete) can never target "both tables at
// once" — admin must say which domain explicitly. Combined mode is read-only,
// for the overview/list/stats views.
function requireSingleDomain(res, resolved) {
  if (resolved?.combined) {
    res.status(400).json({
      error: "Specify a domain ('clinic' or 'pharmacy') for this action — admin oversight view is read-only across both",
    })
    return true
  }
  return false
}

// Clinic expenses always have a recorder relation.
// Pharmacy expenses also have one now (recorded_by added), so both can
// safely include + shape the same way.
function shapeExpense(e, domain) {
  return {
    id: e.id,
    domain,
    description: e.description,
    amount: e.amount,
    incurred_at: e.incurred_at,
    created_at: e.created_at,
    recorder: e.recorded_by_staff
      ? { id: e.recorded_by_staff.id, username: e.recorded_by_staff.username }
      : null,
  }
}

const RECORDER_INCLUDE = {
  recorded_by_staff: {
    select: { id: true, username: true },
  },
}

// ─── GET /api/expenses ────────────────────────────────────────────────────────
module.exports.getExpenses = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError

  const {
    page = 1,
    limit = 20,
    period = 'this_month',
    search = '',
  } = req.query

  const skip = (Number(page) - 1) * Number(limit)

  const where = {
    incurred_at: getPeriodRange(period),
    ...(search.trim() && {
      description: { contains: search.trim(), mode: 'insensitive' },
    }),
  }

  try {
    // ── Admin, no domain specified → combine clinic + pharmacy ──
    if (resolved.combined) {
      // Pull both lists in full (unpaginated at the DB level), tag each row
      // with its domain, merge, sort by date, then paginate in memory.
      // This is fine at clinic data volumes; revisit with a UNION query
      // or cursor-based approach if either table grows very large.
      const [clinicRows, pharmacyRows, clinicTotal, pharmacyTotal] = await Promise.all([
        MODELS.clinic.findMany({ where, include: RECORDER_INCLUDE, orderBy: { incurred_at: 'desc' } }),
        MODELS.pharmacy.findMany({ where, include: RECORDER_INCLUDE, orderBy: { incurred_at: 'desc' } }),
        MODELS.clinic.count({ where }),
        MODELS.pharmacy.count({ where }),
      ])

      const merged = [
        ...clinicRows.map((e) => shapeExpense(e, 'clinic')),
        ...pharmacyRows.map((e) => shapeExpense(e, 'pharmacy')),
      ].sort((a, b) => new Date(b.incurred_at) - new Date(a.incurred_at))

      const paged = merged.slice(skip, skip + Number(limit))

      return res.json({
        expenses: paged,
        total: clinicTotal + pharmacyTotal,
      })
    }

    // ── Single domain (locked role, or admin with ?domain=) ──
    const [expenses, total] = await Promise.all([
      resolved.model.findMany({
        where,
        include: RECORDER_INCLUDE,
        orderBy: { incurred_at: 'desc' },
        skip,
        take: Number(limit),
      }),
      resolved.model.count({ where }),
    ])

    return res.json({
      expenses: expenses.map((e) => shapeExpense(e, resolved.domain)),
      total,
    })
  } catch (error) {
    console.error('getExpenses error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch expenses' })
  }
}

// ─── GET /api/expenses/stats ──────────────────────────────────────────────────
module.exports.getExpenseStats = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError

  const { period = 'this_month' } = req.query
  const where = { incurred_at: getPeriodRange(period) }

  try {
    // ── Admin, no domain specified → combine totals from both tables ──
    if (resolved.combined) {
      const [clinicAgg, pharmacyAgg] = await Promise.all([
        MODELS.clinic.aggregate({ where, _sum: { amount: true }, _count: { id: true } }),
        MODELS.pharmacy.aggregate({ where, _sum: { amount: true }, _count: { id: true } }),
      ])

      const totalAmount = (clinicAgg._sum.amount ?? 0) + (pharmacyAgg._sum.amount ?? 0)
      const entryCount = (clinicAgg._count.id ?? 0) + (pharmacyAgg._count.id ?? 0)

      return res.json({
        total_amount: totalAmount,
        entry_count: entryCount,
        avg_amount: entryCount > 0 ? Math.round(totalAmount / entryCount) : 0,
        by_domain: {
          clinic: { total_amount: clinicAgg._sum.amount ?? 0, entry_count: clinicAgg._count.id ?? 0 },
          pharmacy: { total_amount: pharmacyAgg._sum.amount ?? 0, entry_count: pharmacyAgg._count.id ?? 0 },
        },
      })
    }

    // ── Single domain ──
    const aggregate = await resolved.model.aggregate({
      where,
      _sum: { amount: true },
      _count: { id: true },
      _avg: { amount: true },
    })

    return res.json({
      total_amount: aggregate._sum.amount ?? 0,
      entry_count: aggregate._count.id ?? 0,
      avg_amount: Math.round(aggregate._avg.amount ?? 0),
    })
  } catch (error) {
    console.error('getExpenseStats error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch expense stats' })
  }
}

// ─── POST /api/expenses ───────────────────────────────────────────────────────
module.exports.createExpense = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError
  if (requireSingleDomain(res, resolved)) return

  const { description, amount, incurred_at } = req.body

  if (!description?.trim()) {
    return res.status(400).json({ error: 'Description is required' })
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' })
  }

  try {
    const expense = await resolved.model.create({
      data: {
        description: description.trim(),
        amount: Number(amount),
        incurred_at: incurred_at ? new Date(incurred_at) : new Date(),
        recorded_by: req.user.userId ?? null,
      },
      include: RECORDER_INCLUDE,
    })

    return res.status(201).json(shapeExpense(expense, resolved.domain))
  } catch (error) {
    console.error('createExpense error:', error.message)
    return res.status(500).json({ error: 'Failed to create expense' })
  }
}

// ─── PUT /api/expenses/:id ─────────────────────────────────────────────────────
module.exports.updateExpense = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError
  if (requireSingleDomain(res, resolved)) return

  const expenseId = Number(req.params.id)
  if (!Number.isInteger(expenseId)) {
    return res.status(400).json({ error: 'Invalid expense id' })
  }

  const { description, amount, incurred_at } = req.body

  if (!description?.trim()) {
    return res.status(400).json({ error: 'Description is required' })
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' })
  }

  try {
    const expense = await resolved.model.update({
      where: { id: expenseId },
      data: {
        description: description.trim(),
        amount: Number(amount),
        incurred_at: incurred_at ? new Date(incurred_at) : undefined,
      },
      include: RECORDER_INCLUDE,
    })

    return res.json(shapeExpense(expense, resolved.domain))
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    console.error('updateExpense error:', error.message)
    return res.status(500).json({ error: 'Failed to update expense' })
  }
}

// ─── DELETE /api/expenses/:id ─────────────────────────────────────────────────
module.exports.deleteExpense = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError
  if (requireSingleDomain(res, resolved)) return

  const expenseId = Number(req.params.id)
  if (!Number.isInteger(expenseId)) {
    return res.status(400).json({ error: 'Invalid expense id' })
  }

  try {
    await resolved.model.delete({ where: { id: expenseId } })
    return res.json({ message: 'Expense deleted successfully' })
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    console.error('deleteExpense error:', error.message)
    return res.status(500).json({ error: 'Failed to delete expense' })
  }
}
