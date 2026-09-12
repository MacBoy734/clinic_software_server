const prisma = require('../lib/prisma')
const { getPeriodRange, writeAuditLog } = require('../utils/helpers')

// ─── Domain/role authorization ───────────────────────────────────────────────

const ROLE_TO_DOMAIN = {
  receptionist: 'clinic',
  pharmacist: 'pharmacy',
}

const MODELS = {
  clinic: prisma.clinicExpense,
  pharmacy: prisma.pharmacyExpense,
}

function resolveDomain(req) {
  const role = req.user.role
  const requestedDomain = req.query?.domain || req.body?.domain

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

  const allowedDomain = ROLE_TO_DOMAIN[role]
  if (!allowedDomain) return null

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

function requireSingleDomain(res, resolved) {
  if (resolved?.combined) {
    res.status(400).json({
      error: "Specify a domain ('clinic' or 'pharmacy') for this action",
    })
    return true
  }
  return false
}

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

  const { page, limit, period, search } = req.query
  const skip = (Number(page) - 1) * Number(limit)

  const where = {
    incurred_at: getPeriodRange(period),
    ...(search?.trim() && {
      description: { contains: search.trim(), mode: 'insensitive' },
    }),
  }

  try {
    if (resolved.combined) {
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

  const { period } = req.query
  const where = { incurred_at: getPeriodRange(period) }

  try {
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
  const ip = req.ip ?? null
  const currentUser = req.user
  if (domainError) return domainError
  if (requireSingleDomain(res, resolved)) return

    const { description, amount, incurred_at } = req.body

  const amt = Math.round(Number(amount))
  if (!Number.isInteger(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number' })
  }

  try {
    const expense = await resolved.model.create({
      data: {
        description,
        amount,
        incurred_at: new Date(),
        recorded_by: req.user.id ?? null,
      },
      include: RECORDER_INCLUDE,
    })

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'Recorded Expense',
        description: `Recorded expense with description: ${description}, amount: ${amount}`,
        category: 'Expense',
        entity: 'Expense',
        entityId: expense.id,
        ipAddress: ip,
      })
    } catch (sideErr) {
      console.error('record expense side effect failed:', sideErr.message)
    }

    return res.status(201).json(shapeExpense(expense, resolved.domain))
  } catch (error) {
    console.error('createExpense error:', error.message)
    return res.status(500).json({ error: 'Failed to create expense' })
  }
}

module.exports.updateExpense = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError
  if (requireSingleDomain(res, resolved)) return

  const { id } = req.params
  const { description, amount, incurred_at } = req.body
  const currentUser = req.user
  const ip = req.ip ?? null

  try {
    const before = await resolved.model.findUnique({ where: { id } })
    if (!before) return res.status(404).json({ error: 'Expense not found' })

    const expense = await resolved.model.update({
      where: { id },
      data: {
        description,
        amount,
        incurred_at: incurred_at || undefined,
      },
      include: RECORDER_INCLUDE,
    })

    // Amount changes are the reason this log exists — record both values.
    const changes = []
    if (before.description !== expense.description) {
      changes.push(`description "${before.description}" → "${expense.description}"`)
    }
    if (before.amount !== expense.amount) {
      changes.push(`amount ${before.amount} → ${expense.amount}`)
    }
    if (before.incurred_at.getTime() !== expense.incurred_at.getTime()) {
      changes.push(`date ${before.incurred_at.toISOString().slice(0, 10)} → ${expense.incurred_at.toISOString().slice(0, 10)}`)
    }

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'Updated Expense',
        description: changes.length
          ? `Updated ${resolved.domain} expense #${id}: ${changes.join(', ')}`
          : `Updated ${resolved.domain} expense #${id} (no field changed)`,
        category: 'Expense',
        entity: 'Expense',
        entityId: expense.id,
        ipAddress: ip,
      })
    } catch (sideErr) {
      console.error('update expense audit log failed:', sideErr.message)
    }

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
// ─── DELETE /api/expenses/:id ─────────────────────────────────────────────────
module.exports.deleteExpense = async (req, res) => {
  const resolved = resolveDomain(req)
  const domainError = domainErrorResponse(res, resolved)
  if (domainError) return domainError
  if (requireSingleDomain(res, resolved)) return

  const { id } = req.params
  const currentUser = req.user
  const ip = req.ip ?? null

  try {
    const existing = await resolved.model.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ error: 'Expense not found' })

    await resolved.model.delete({ where: { id } })

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'Deleted Expense',
        // The row is gone — the log is the only remaining record of it.
        description:
          `Deleted ${resolved.domain} expense #${id}: "${existing.description}", ` +
          `amount ${existing.amount}, incurred ${existing.incurred_at.toISOString().slice(0, 10)}`,
        category: 'Expense',
        entity: 'Expense',
        entityId: Number(id),
        ipAddress: ip,
      })
    } catch (sideErr) {
      console.error('delete expense audit log failed:', sideErr.message)
    }

    return res.json({ message: 'Expense deleted successfully' })
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Expense not found' })
    }
    console.error('deleteExpense error:', error.message)
    return res.status(500).json({ error: 'Failed to delete expense' })
  }
}