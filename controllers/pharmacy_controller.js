

const prisma = require('../lib/prisma')

const { getIO } = require('../utils/socket')
const { createNotification, writeAuditLog, NOTIFICATION_TYPES, validatePaymentLines, recomputeMedicationFee } = require('../utils/helpers')


const CATEGORIES = ['medication', 'consumable', 'general']

const MEDICATION = 'medication'

const SUPPLY_CATEGORIES = CATEGORIES.filter((c) => c !== MEDICATION)

const PRICE_TIERS = ['normal', 'promotional', 'wholesale']
const OFF_CATALOGUE_PRICE_CAP = 20000
const ORDER_DEPARTMENTS = ['doctor', 'lab', 'admin']
const LOCK = { PRODUCT: 1, CUSTOMER: 2 }
function lockProduct(tx, productId) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK.PRODUCT}::int, ${productId}::int)`
}

exports.CATEGORIES = CATEGORIES
exports.MEDICATION = MEDICATION
exports.SUPPLY_CATEGORIES = SUPPLY_CATEGORIES

const STOCKTAKE_WORKLIST_SIZE = 60
const STOCKTAKE_MAX_SIZE = 200

const STOCKTAKE_REASONS = [
  'expired', 'damaged', 'broken', 'stolen',
  'miscounted', 'misplaced', 'found_unrecorded', 'other',
]

const httpError = (message, status = 400, meta) =>
  Object.assign(new Error(message), { status, meta })


const TAX_RATES = {
  exempt: 0,
  zero_rated: 0,
  standard: 0.16,
}

function taxOnGross(gross, taxClass) {
  const rate = TAX_RATES[taxClass] ?? 0
  if (rate <= 0) return 0
  return Math.round((gross * rate) / (1 + rate))
}


function safeIO() {
  try { return getIO() } catch { return null }
}
function emit(event, payload, role) {
  try {
    const io = safeIO()
    if (!io) return

    if (!role) {
      io.emit(event, payload)
    } else if (Array.isArray(role)) {
      role.forEach((r) => io.to(r).emit(event, payload))
    } else {
      io.to(role).emit(event, payload)
    }
  } catch (e) {
    console.error(`Socket emit ${event} failed:`, e.message)
  }
}

class ShortfallError extends Error {
  constructor(shortfalls) {
    super('insufficient stock')
    this.shortfalls = shortfalls
  }
}

// ─── Stock ledger helpers ────────────────────────────────────────────────────


module.exports.takeStock = async function (tx, { productId, quantity, reason, refType, refId, staffId, note }) {
  if (!productId || !quantity || quantity <= 0) return null

  await lockProduct(tx, productId)

  // Read current state first
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { current_stock: true, name: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)
  if (product.current_stock < quantity) return null

  // Find available batches — FEFO: oldest expiry first, then oldest received
  const batches = await tx.productBatch.findMany({
    where: {
      product_id: productId,
      is_exhausted: false,
      quantity: { gt: 0 },
    },
    orderBy: [{ expiry_date: 'asc' }, { received_at: 'asc' }],
  })

  const batchTotal = batches.reduce((sum, b) => sum + b.quantity, 0)

  // If batches exist but don't cover the quantity, data is inconsistent
  if (batches.length > 0 && batchTotal < quantity) {
    throw new Error(
      `Stock inconsistency for ${product.name}: product stock=${product.current_stock}, ` +
      `batch total=${batchTotal}, requested=${quantity}`
    )
  }

  // Atomically decrement product stock
  const guard = await tx.product.updateMany({
    where: { id: productId, current_stock: { gte: quantity } },
    data: { current_stock: { decrement: quantity } },
  })
  if (guard.count === 0) return null

  const updatedProduct = await tx.product.findUnique({
    where: { id: productId },
    select: { current_stock: true },
  })

  const batches_used = []
  let remaining = quantity

  if (batches.length === 0) {
    throw new Error(
      `${product.name} has stock (${product.current_stock}) but no batch records — ` +
      `cannot deduct. Create an opening-balance batch for this product first.`
    )
  }


  // Walk batches oldest-first (FEFO).
  // If oldest doesn't have enough, exhaust it and move to the next oldest.
  for (const batch of batches) {
    if (remaining <= 0) break

    const deduct = Math.min(batch.quantity, remaining)
    const newQty = batch.quantity - deduct

    await tx.productBatch.update({
      where: { id: batch.id },
      data: {
        quantity: newQty,
        is_exhausted: newQty === 0,
      },
    })

    await tx.stockMovement.create({
      data: {
        product_id: productId,
        batch_id: batch.id,
        delta: -deduct,
        reason,
        ref_type: refType ?? null,
        ref_id: refId ?? null,
        balance_after: updatedProduct.current_stock,
        note: note
          ? `${note} (batch #${batch.batch_number})`
          : `Deducted from batch #${batch.batch_number}`,
        staff_id: staffId ?? null,
      },
    })

    batches_used.push({
      batch_id: batch.id,
      batch_number: batch.batch_number,
      quantity_deducted: deduct,
    })

    remaining -= deduct
  }

  // Bulletproof: if batches ran dry despite our check, explode loudly
  if (remaining > 0) {
    throw new Error(
      `Batch deduction failed for ${product.name}: ` +
      `${remaining} units remaining after exhausting all batches`
    )
  }

  return {
    balance_after: updatedProduct.current_stock,
    batches_used,
  }
}

module.exports.giveStock = async function (tx, { productId, quantity, batch_id, reason, refType, refId, staffId, note }) {
  if (!productId || !quantity || quantity <= 0) return null

  await lockProduct(tx, productId)

  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { current_stock: true, name: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  const updatedProduct = await tx.product.update({
    where: { id: productId },
    data: { current_stock: { increment: quantity } },
    select: { current_stock: true },
  })

  let targetBatch = null
  let alreadyIncremented = false

  // ── Try exact batch first (returns) ──
  if (batch_id) {
    const exactBatch = await tx.productBatch.findUnique({
      where: { id: batch_id },
    })

    if (exactBatch && exactBatch.product_id === productId) {
      targetBatch = await tx.productBatch.update({
        where: { id: batch_id },
        data: {
          quantity: { increment: quantity },
          is_exhausted: false,
        },
      })
      alreadyIncremented = true
    }
    // If not found or belongs to wrong product: silently fall through
  }

  // ── Fallback: oldest non-exhausted batch (FEFO) ──
  if (!targetBatch) {
    targetBatch = await tx.productBatch.findFirst({
      where: {
        product_id: productId,
        is_exhausted: false,
        quantity: { gte: 0 },
      },
      orderBy: [{ expiry_date: 'asc' }, { received_at: 'asc' }],
    })
  }

  // ── Increment the fallback batch if we haven't already ──
  if (targetBatch && !alreadyIncremented) {
    targetBatch = await tx.productBatch.update({
      where: { id: targetBatch.id },
      data: {
        quantity: { increment: quantity },
        is_exhausted: false,
      },
    })
    alreadyIncremented = true
  }

  // ── Last resort: create adjustment batch ──
  if (!targetBatch) {
    targetBatch = await tx.productBatch.create({
      data: {
        product_id: productId,
        quantity: quantity,
        received_at: new Date(),
        notes: note || 'Stock adjustment / return fallback',
      },
    })
  }

  await tx.stockMovement.create({
    data: {
      product_id: productId,
      batch_id: targetBatch.id,
      delta: quantity,
      reason,
      ref_type: refType ?? null,
      ref_id: refId ?? null,
      balance_after: updatedProduct.current_stock,
      note: note
        ? `${note} (batch #${targetBatch.batch_number})`
        : `Credited to batch #${targetBatch.batch_number}`,
      staff_id: staffId ?? null,
    },
  })

  return {
    balance_after: updatedProduct.current_stock,
    batch_credited: {
      batch_id: targetBatch.id,
      batch_number: targetBatch.batch_number,
    },
  }
}


function shapeProduct(p) {
  return {
    id: p.id,
    sku: p.sku ?? null,
    name: p.name,
    category: p.category,
    sub_category: p.sub_category ?? null,
    unit: p.unit,
    is_active: p.is_active,

    // medication-only, null for everything else
    generic_name: p.generic_name ?? null,
    form: p.form ?? null,
    strength: p.strength ?? null,

    current_stock: p.current_stock,
    reorder_level: p.reorder_level,
    unit_price: p.normal_price,
    normal_price: p.normal_price,
    pharmacy_normal_price: p.normal_price, // legacy alias
    promotional_price: p.promotional_price,
    wholesale_price: p.wholesale_price,
    shelf_location: p.shelf_location ?? null,
    supplier: p.supplier ?? null,
    stock_value: p.current_stock * p.normal_price,
    updated_at: p.updated_at,
  }
}

function shapeStocktakeMeta(s) {
  return {
    id: s.id,
    label: s.label,
    status: s.status,
    blind: s.blind,
    started_by: s.started_by,
    started_at: s.started_at,
    submitted_by: s.submitted_by ?? null,
    submitted_at: s.submitted_at ?? null,
    reviewed_by: s.reviewed_by ?? null,
    reviewed_at: s.reviewed_at ?? null,
    review_notes: s.review_notes ?? null,
  }
}


function shapeStocktakeItem(item, hideSystem, moved) {
  const base = {
    id: item.id,
    product_id: item.product_id,
    product_name: item.product?.name ?? null,
    unit: item.product?.unit ?? null,
    category: item.product?.category ?? null,
    shelf_location: item.shelf_location ?? null,
    counted_qty: item.counted_qty,
    counted_at: item.counted_at,
    counted_by: item.counted_by ?? null,
    reason: item.reason ?? null,
    note: item.note ?? null,
    posted_at: item.posted_at ?? null,
  }
  if (hideSystem) return base

    return {
    ...base,
    system_qty: item.system_qty,
    variance: item.variance,
    retail_value: item.variance != null
      ? Math.abs(item.variance) * (item.product?.normal_price ?? 0)
      : 0,
    moved_since_count: moved?.net ?? 0,
    movements_since_count: moved?.movements ?? 0,
    last_moved_at: moved?.last_moved_at ?? null,
  }
}

function summariseStocktake(items) {
  const counted = items.filter((i) => i.counted_at != null)
  const disc = counted.filter((i) => i.variance !== 0)
  return {
    total_items: items.length,
    counted_items: counted.length,
    uncounted_items: items.length - counted.length,
    discrepancy_count: disc.length,
    total_missing: disc.reduce((s, i) => s + Math.min(0, i.variance), 0),
    total_found: disc.reduce((s, i) => s + Math.max(0, i.variance), 0),
    retail_value_missing: disc.reduce(
      (s, i) => s + (i.variance < 0 ? Math.abs(i.variance) * (i.product?.normal_price ?? 0) : 0),
      0
    ),
  }
}

function stocktakeProgress(items) {
  const counted = items.filter((i) => i.counted_at != null).length
  return {
    total_items: items.length,
    counted_items: counted,
    uncounted_items: items.length - counted,
  }
}

const STOCKTAKE_INCLUDE = {
  items: {
    include: {
      product: { select: { id: true, name: true, unit: true, category: true, normal_price: true } },
    },
    orderBy: [{ shelf_location: 'asc' }, { id: 'asc' }],
  },
}

function shapePrescription(p) {
  return {
    id: p.id,
    visit_id: p.visit_id,
    status: p.status,
    notes: p.notes ?? null,
    prescribed_by: p.prescribed_by ?? null,
    prescribed_at: p.created_at,
    dispensed_at: p.dispensed_at ?? null,
    cancelled_by: p.cancelled_by ?? null,
    cancelled_at: p.cancelled_at ?? null,
    cancel_reason: p.cancel_reason ?? null,
    patient_name: p.visit?.patient?.name ?? null,
    patient_age: p.visit?.patient?.age ?? null,
    patient_gender: p.visit?.patient?.gender ?? null,
    items: (p.items ?? []).map((it) => ({
      id: it.id,
      medication: it.drug_name,
      product_id: it.product_id ?? null,
      drug_id: it.product_id ?? null,
      form: it.form ?? null,
      dosage: it.dosage,
      frequency: it.frequency,
      duration: it.duration,
      quantity: it.quantity,
      unit_cost: it.unit_cost,
      status: it.status,
      decline_reason: it.decline_reason ?? null,
      dispensed_at: it.dispensed_at ?? null,
      return_reason: it.return_reason ?? null,
      returned_by: it.returned_by ?? null,
      returned_at: it.returned_at ?? null,
      product_batch_id: it.product_batch_id ?? null,
      available_stock: it.product?.current_stock ?? null,
    })),
  }
}

function shapeRestockRequest(r) {
  return {
    id: r.id,
    department: r.department,
    product_id: r.product_id,
    drug_stock_id: r.product_id, // legacy alias
    product_name: r.product?.name ?? null,
    drug_name: r.product?.name ?? null, // legacy alias
    product_category: r.product?.category ?? null,
    unit: r.product?.unit ?? null,
    current_stock: r.product?.current_stock ?? null,
    requested_qty: r.quantity,
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
}

function shapeOrder(o) {
  return {
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
    items: (o.items ?? []).map((it) => ({
      id: it.id,
      name: it.name,
      quantity: it.quantity,
      fulfilled_qty: it.fulfilled_qty,
      notes: it.notes ?? null,
      product_id: it.product_id ?? null,
      // Lets the fulfil modal warn BEFORE the pharmacist commits.
      category: it.product?.category ?? null,
      sub_category: it.product?.sub_category ?? null,
      unit: it.product?.unit ?? null,
      available_stock: it.product?.current_stock ?? null,
      is_tracked: it.product_id != null,
    })),
  }
}

function shapeSale(s) {
  const returnedByItem = new Map()
  for (const r of s.returns ?? []) {
    for (const ri of r.items ?? []) {
      returnedByItem.set(ri.sale_item_id, (returnedByItem.get(ri.sale_item_id) || 0) + ri.quantity)
    }
  }

  return {
    id: s.id,
    receipt_number: s.receipt_number,
    customer_name: s.customer_name,
    payment_method: s.payment_method,
    sold_by: s.sold_by_staff?.username ?? 'Pharmacist',
    sold_at: s.sold_at,
    subtotal: s.subtotal,
    tax_total: s.tax_total,
    total: s.total,
    discount_amount: s.discount_amount,
    discount_reason: s.discount_reason,
    discount_by: s.discount_by,
    is_credit: s.payment_method === 'credit',
    customer: s.customer ? { id: s.customer.id, name: s.customer.name, phone: s.customer.phone } : null,
    payments: (s.payments || []).map((p) => ({
      method: p.method,
      amount: p.amount,
      reference: p.reference,
    })),
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
    items: (s.items || []).map((it) => {
      const returned = returnedByItem.get(it.id) || 0
      return {
        id: it.id,
        product_batch_id: it.product_batch_id ?? null,
        name: it.name,
        quantity: it.quantity,
        returned_qty: returned,
        returnable_qty: it.quantity - returned,
        unit_price: it.unit_price,
        tax_amount: it.tax_amount,
        price_tier: it.price_tier,
        product_id: it.product_id ?? null,
        category: it.product?.category ?? null,
        unit: it.product?.unit ?? null,
      }
    }),
  }
}

const PRESCRIPTION_INCLUDE = {
  items: { include: { product: { select: { id: true, current_stock: true, unit: true } } } },
  visit: { include: { patient: { select: { name: true, age: true, gender: true } } } },
}

const RESTOCK_INCLUDE = {
  product: {
    select: { id: true, name: true, unit: true, current_stock: true, category: true },
  },
}

const ORDER_INCLUDE = {
  items: {
    include: {
      product: {
        select: {
          id: true, category: true, sub_category: true, unit: true, current_stock: true,
        },
      },
    },
  },
}


function categoryWhere({ category, categories, exclude }) {
  if (CATEGORIES.includes(category)) return category

  if (typeof categories === 'string' && categories.trim()) {
    const list = categories.split(',')
      .map((c) => c.trim())
      .filter((c) => CATEGORIES.includes(c))
    if (list.length) return { in: list }
  }

  if (typeof exclude === 'string' && exclude.trim()) {
    const list = exclude.split(',')
      .map((c) => c.trim())
      .filter((c) => CATEGORIES.includes(c))
    if (list.length) return { notIn: list }
  }

  return undefined
}

exports.getProducts = async (req, res) => {
  try {
    const { q, sub_category, in_stock, include_inactive } = req.query

    const where = {}
    if (include_inactive !== '1') where.is_active = true

    const cat = categoryWhere(req.query)
    if (cat !== undefined) where.category = cat

    if (typeof sub_category === 'string' && sub_category.trim() && sub_category !== 'all') {
      where.sub_category = sub_category.trim()
    }
    if (in_stock === '1') where.current_stock = { gt: 0 }

    const term = typeof q === 'string' ? q.trim() : ''
    if (term) {
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { generic_name: { contains: term, mode: 'insensitive' } },
        { sub_category: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
      ]
    }

    const items = await prisma.product.findMany({
      where,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: 500,
    })

    const shaped = items.map((p) => shapeProduct(p))

    res.json({
      items: shaped,
      categories: CATEGORIES,
      sub_categories: [...new Set(shaped.map((i) => i.sub_category).filter(Boolean))].sort(),
    })
  } catch (err) {
    console.error('getProducts', err)
    res.status(500).json({ error: 'Failed to fetch products' })
  }
}

exports.getDrugs = async (req, res) => {
  req.query = { ...req.query, category: MEDICATION }
  return exports.getProducts(req, res)
}

exports.getCategories = async (req, res) => {
  try {
    const rows = await prisma.product.groupBy({
      by: ['category', 'sub_category'],
      where: { is_active: true },
      _count: { _all: true },
    })

    const byCategory = CATEGORIES.map((c) => {
      const own = rows.filter((r) => r.category === c)
      return {
        category: c,
        count: own.reduce((s, r) => s + r._count._all, 0),
        sub_categories: own
          .filter((r) => r.sub_category)
          .map((r) => ({ name: r.sub_category, count: r._count._all }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }
    })

    res.json({ categories: byCategory })
  } catch (err) {
    console.error('getCategories', err)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
}


exports.getStock = async (req, res) => {
  try {
    const where = {}
    const cat = categoryWhere(req.query)
    if (cat !== undefined) where.category = cat
    if (req.query.include_inactive !== '1') where.is_active = true

    const items = await prisma.product.findMany({
      where,
      orderBy: [{ category: 'asc' }, { sub_category: 'asc' }, { name: 'asc' }],
    })

    const shaped = items.map((p) => shapeProduct(p))

    res.json({
      items: shaped,
      stats: {
        total: shaped.length,
        low_stock: shaped.filter((i) => i.current_stock > 0 && i.current_stock <= i.reorder_level).length,
        out_of_stock: shaped.filter((i) => i.current_stock === 0).length,
        stock_value: shaped.reduce((s, i) => s + i.stock_value, 0), // at COST
        retail_value: shaped.reduce((s, i) => s + i.current_stock * i.normal_price, 0),
      },
      categories: CATEGORIES,
      sub_categories: [...new Set(shaped.map((i) => i.sub_category).filter(Boolean))].sort(),
    })
  } catch (err) {
    console.error('getStock', err)
    res.status(500).json({ error: 'Failed to fetch stock' })
  }
}


exports.getRestockRequests = async (req, res) => {
  try {
    const { status } = req.query
    const valid = ['pending', 'approved', 'rejected']
    const cat = categoryWhere(req.query)

    const requests = await prisma.restockRequest.findMany({
      where: {
        department: 'pharmacy',
        ...(valid.includes(status) ? { status } : {}),
        ...(cat !== undefined ? { product: { category: cat } } : {}),
      },
      include: RESTOCK_INCLUDE,
      orderBy: { requested_at: 'desc' },
      take: 200,
    })

    const shaped = requests.map(shapeRestockRequest)
    res.json({
      requests: shaped,
      stats: {
        pending: shaped.filter((r) => r.status === 'pending').length,
        approved: shaped.filter((r) => r.status === 'approved').length,
        rejected: shaped.filter((r) => r.status === 'rejected').length,
      },
    })
  } catch (err) {
    console.error('getRestockRequests', err.message)
    res.status(500).json({ error: 'Failed to fetch restock requests' })
  }
}


exports.createRestockRequest = async (req, res) => {
  const currentUser = req.user
  const { product_id, quantity, expiry_date, notes } = req.body

  const productId = parseInt(product_id ?? req.body.drug_stock_id)
  const qty = parseInt(quantity)

  if (!Number.isInteger(productId)) {
    return res.status(400).json({ error: 'product_id is required' })
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive whole number' })
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
    const product = await prisma.product.findUnique({ where: { id: productId } })
    if (!product) return res.status(404).json({ error: 'Product not found' })

    const existing = await prisma.restockRequest.findFirst({
      where: { department: 'pharmacy', product_id: productId, status: 'pending' },
    })
    if (existing) {
      return res.status(409).json({
        error: `A restock request for ${product.name} is already awaiting approval`,
        request_id: existing.id,
      })
    }

    const created = await prisma.restockRequest.create({
      data: {
        department: 'pharmacy',
        product_id: productId,
        lab_stock_id: null,
        quantity: qty,
        expiry_date: expiry,
        notes: (typeof notes === 'string' && notes.trim()) || null,
        status: 'pending',
        requested_by: currentUser?.username ?? 'unknown',
        requested_by_id: currentUser?.id ?? null,
      },
      include: RESTOCK_INCLUDE,
    })

    await createNotification({
      targetRoles: ['admin'],
      type: NOTIFICATION_TYPES.RESTOCK_REQUESTED,
      title: 'Restock request',
      message: `${currentUser?.username ?? 'Pharmacy'} requested ${qty} ${product.unit} of ${product.name} (current stock: ${product.current_stock}).`,
    })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'request_restock',
      description: `Requested ${qty} ${product.unit} of ${product.name}`,
      category: 'stock',
      entity: 'restock_request',
      entityId: created.id,
      ipAddress: req.ip ?? null,
    })

    return res.status(201).json({ success: true, request: shapeRestockRequest(created) })
  } catch (err) {
    console.error('createRestockRequest', err.message)
    return res.status(500).json({ error: 'Failed to submit restock request' })
  }
}


exports.getQueue = async (req, res) => {
  try {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0))

    const [active, dispensedToday] = await Promise.all([
      prisma.prescription.findMany({
        where: {
          OR: [
            { status: 'pending' },
            { status: 'returned' },
            {
              status: 'issued',
              items: { some: { status: 'returned' } },
            },
          ],
        },
        include: PRESCRIPTION_INCLUDE,
        orderBy: { updated_at: 'desc' },
      }),
      prisma.prescription.count({
        where: {
          status: { in: ['issued'] },
          dispensed_at: { gte: todayStart },
        },
      }),
    ])

    res.json({
      prescriptions: active.map(shapePrescription),
      dispensed_today: dispensedToday,
    })
  } catch (err) {
    console.error('getQueue', err.message)
    res.status(500).json({ error: 'Failed to fetch queue' })
  }
}

exports.dispensePrescription = async (req, res) => {
  const id = parseInt(req.params.id)
  const currentUser = req.user
  const ip = req.ip ?? null

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Prescription ID is required' })
  }

  try {
    // ── Pre-flight read (outside tx — cheap validation) ────────────────────
    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: PRESCRIPTION_INCLUDE,
    })
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' })
    if (prescription.status !== 'pending') {
      return res.status(400).json({ error: `Prescription is already ${prescription.status}` })
    }

    const now = new Date()

    // ── Transaction with row locking ───────────────────────────────────────
    const result = await prisma.$transaction(async (tx) => {
      // Lock prescription + bill so no concurrent operation can mutate them
      await tx.$queryRaw`SELECT id FROM prescriptions WHERE id = ${id} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM bills WHERE visit_id = ${prescription.visit_id} FOR UPDATE`

      // Re-verify status inside the lock (paranoid)
      const freshRx = await tx.prescription.findUnique({
        where: { id },
        select: { status: true },
      })
      if (freshRx?.status !== 'pending') {
        throw Object.assign(new Error('Prescription was modified by another user'), { status: 409 })
      }

      const freshItems = await tx.prescriptionItem.findMany({
        where: { prescription_id: id, status: 'pending' },
        orderBy: { id: 'asc' },
      })
      const linked = freshItems.filter((it) => it.product_id != null)
      const unlinked = freshItems.filter((it) => it.product_id == null)

      const issuedItems = []
      const declinedItems = []

      // ── Linked items: attempt stock deduction ────────────────────────────
      for (const it of linked) {
        const stockResult = await takeStock(tx, {
          productId: it.product_id,
          quantity: it.quantity,
          reason: 'dispense',
          refType: 'prescription',
          refId: id,
          staffId: currentUser?.id,
          note: `Visit #${prescription.visit_id} — ${it.drug_name}`,
        })

        if (stockResult === null) {
          // Stock guard failed — determine WHY for the response
          const row = await tx.product.findUnique({
            where: { id: it.product_id },
            select: { current_stock: true, name: true },
          })
          const available = row?.current_stock ?? 0

          await tx.prescriptionItem.update({
            where: { id: it.id },
            data: {
              status: 'declined',
              decline_reason:
                available === 0
                  ? 'Out of stock'
                  : `Insufficient stock (available: ${available}, requested: ${it.quantity})`,
            },
          })

          declinedItems.push({
            item_id: it.id,
            medication: it.drug_name,
            requested: it.quantity,
            available,
            reason:
              available === 0
                ? 'Out of stock'
                : `Insufficient stock (available: ${available})`,
          })
        } else {
          await tx.prescriptionItem.update({
            where: { id: it.id },
            data: {
              status: 'issued',
              dispensed_at: now,
              product_batch_id: stockResult.batches_used?.[0]?.batch_id ?? null,
            },
          })
          issuedItems.push(it)
        }
      }

      // ── Unlinked items: nothing to dispense ──────────────────────────────
      for (const it of unlinked) {
        await tx.prescriptionItem.update({
          where: { id: it.id },
          data: {
            status: 'declined',
            decline_reason: 'Not linked to inventory product',
          },
        })
        declinedItems.push({
          item_id: it.id,
          medication: it.drug_name,
          requested: it.quantity,
          available: 0,
          reason: 'Not in inventory',
        })
      }

      // ── Prescription status ──────────────────────────────────────────────
      // If we issued at least 1 item → 'issued'. If 0 issued → keep 'pending'
      // so pharmacy can retry after restock without the doctor rewriting.
      const prescriptionStatus = issuedItems.length > 0 ? 'issued' : 'pending'

      const p = await tx.prescription.update({
        where: { id },
        data: {
          status: prescriptionStatus,
          dispensed_at: issuedItems.length > 0 ? now : null,
          pharmacist_id: currentUser?.id ?? null,
        },
        include: PRESCRIPTION_INCLUDE,
      })

      // ── Recompute bill (locked row) ──────────────────────────────────────
      await recomputeMedicationFee(tx, prescription.visit_id)

      // ── Visit routing ────────────────────────────────────────────────────
      await tx.visit.update({
        where: { id: prescription.visit_id },
        data: {
          status: 'with_doctor',
          medication_verification: true,
        },
      })

      return {
        prescription: p,
        issuedCount: issuedItems.length,
        declinedCount: declinedItems.length,
        declinedItems,
      }
    }, { timeout: 15000 }) // generous timeout for batch operations

    // ── Side effects (outside transaction) ─────────────────────────────────
    try {
      await createNotification({
        targetRoles: ['doctor'],
        type: NOTIFICATION_TYPES.RX_DISPENSED,
        title: result.declinedCount > 0 ? 'Prescription partially dispensed' : 'Prescription dispensed',
        visitId: prescription.visit_id,
        message:
          result.declinedCount > 0
            ? `Prescription #${id} — ${result.issuedCount} issued, ${result.declinedCount} declined.`
            : `Prescription #${id} fully dispensed.`,
        io: safeIO(),
      })
    } catch (e) {
      console.error('createNotification failed:', e.message)
    }

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'dispense_prescription',
        description: `Dispensed #${id} — ${result.issuedCount} issued, ${result.declinedCount} declined`,
        category: 'prescription',
        entity: 'prescription',
        entityId: id,
        ipAddress: ip,
      })
    } catch (e) {
      console.error('writeAuditLog failed:', e.message)
    }

    emit(
      'rx:dispensed',
      {
        visitId: prescription.visit_id,
        prescriptionId: id,
        patientName: prescription.visit?.patient?.name,
        issuedCount: result.issuedCount,
        declinedCount: result.declinedCount,
        declinedItems: result.declinedItems,
      },
      'doctor'
    )

    return res.json({
      success: true,
      prescription: shapePrescription(result.prescription),
      partial: result.declinedCount > 0,
      issued_count: result.issuedCount,
      declined_count: result.declinedCount,
      declined_items: result.declinedItems,
    })
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message })
    }
    console.error('dispensePrescription', err.message)
    return res.status(500).json({ error: 'Failed to dispense prescription' })
  }
}

exports.confirmRestock = async (req, res) => {
  try {
    const itemId = req.params.id
    const currentUser = req.user

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM prescription_items WHERE id = ${itemId} FOR UPDATE`

      const item = await tx.prescriptionItem.findUnique({
        where: { id: itemId },
        include: { prescription: { select: { visit_id: true } } },
      })
      if (!item) throw Object.assign(new Error('Item not found'), { status: 404 })
      if (item.status !== 'returned') {
        throw Object.assign(
          new Error(`Only returned items can be restocked. ${item.drug_name} is "${item.status}".`),
          { status: 409 }
        )
      }

      let stockRestored = false
      if (item.product_id) {
        await giveStock(tx, {
          productId: item.product_id,
          batch_id: item.product_batch_id ?? null,
          quantity: item.quantity,
          reason: 'return_to_stock',
          refType: 'prescription_item',
          refId: item.id,
          staffId: currentUser?.id,
          note: `Returned from visit #${item.prescription.visit_id}`,
        })
        stockRestored = true
      }

      await tx.prescriptionItem.update({
        where: { id: itemId },
        data: {
          status: 'restocked',
          restocked_by: currentUser?.username ?? null,
          restocked_at: new Date(),
        },
      })

      // No fee recompute: the charge came off at return time, and `restocked`
      // is not billable either.

      return {
        visitId: item.prescription.visit_id,
        drugName: item.drug_name,
        quantity: item.quantity,
        stockRestored,
      }
    })

    try {
      const io = safeIO()
      if (io) io.to('doctor').emit('prescription:restocked', { visit_id: result.visitId, item_id: itemId })
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'confirm_restock',
        description: `${result.drugName} ×${result.quantity} ${result.stockRestored ? 'returned to stock' : 'marked restocked (no linked product)'} — visit #${result.visitId}`,
        category: 'stock',
        entity: 'prescription_item',
        entityId: itemId,
        ipAddress: req.ip ?? null,
      })
    } catch (sideErr) {
      console.error('confirmRestock side effect failed:', sideErr.message)
    }

    res.json({
      success: true,
      stock_restored: result.stockRestored,
      message: result.stockRestored
        ? `${result.drugName} restocked (+${result.quantity})`
        : `${result.drugName} marked restocked (no linked stock item)`,
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('confirmRestock', err.message)
    res.status(500).json({ error: 'Failed to confirm restock' })
  }
}



exports.cancelPrescription = async (req, res) => {
  const id = parseInt(req.params.id)
  const { reason } = req.body
  const currentUser = req.user
  const ip = req.ip ?? null

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Prescription ID is required' })
  }

  try {
    const prescription = await prisma.prescription.findUnique({ where: { id } })
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' })

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM prescriptions WHERE id = ${id} FOR UPDATE`

      const fresh = await tx.prescription.findUnique({
        where: { id },
        select: { status: true },
      })
      if (fresh?.status !== 'pending') {
        throw Object.assign(
          new Error(`Prescription is already ${fresh?.status ?? 'gone'}`),
          { status: 409 }
        )
      }
      await tx.prescriptionItem.updateMany({
        where: { prescription_id: id },
        data: { status: 'cancelled' },
      })

      const p = await tx.prescription.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelled_by: currentUser?.username ?? null,
          cancelled_at: new Date(),
          cancel_reason: reason ?? null,
        },
        include: PRESCRIPTION_INCLUDE,
      })

      await tx.visit.update({
        where: { id: prescription.visit_id },
        data: { status: 'with_doctor' },
      })

      return p
    })

    try {
      await createNotification({
        targetRoles: ['doctor'],
        type: NOTIFICATION_TYPES.RX_CANCELLED,
        title: 'Prescription cancelled',
        visitId: prescription.visit_id,
        message: `Prescription #${prescription.id} was cancelled at the pharmacy by ${currentUser?.username ?? 'unknown'}. Reason: ${reason ?? 'not given'}`,
        io: safeIO(),
      })
    } catch (e) { console.error('createNotification failed:', e.message) }

    try {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'cancel_prescription',
        description: `Cancelled prescription #${id} for visit #${prescription.visit_id}`,
        category: 'prescription',
        entity: 'prescription',
        entityId: id,
        ipAddress: ip,
      })
    } catch (e) { console.error('writeAuditLog failed:', e.message) }

    emit('rx:cancelled', { visitId: prescription.visit_id, prescriptionId: id }, 'doctor')

    res.json({ success: true, prescription: shapePrescription(updated) })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('cancelPrescription', err.message)
    res.status(500).json({ error: 'Failed to cancel prescription' })
  }
}

exports.createOtcSale = async (req, res) => {
  const currentUser = req.user
  const { customer_name, customer_phone, payments, items, discount_amount, discount_reason } = req.body

  const norm = items.map((i) => ({
    productId: i.product_id ?? null,
    name: i.name?.trim() || '',
    quantity: i.quantity,
    tier: i.price_tier || 'normal',
    clientPrice: i.unit_price || 0,
  }))

  try {
    const sale = await prisma.$transaction(async (tx) => {
      const ids = norm.filter((n) => n.productId != null).map((n) => n.productId)
      const rows = ids.length ? await tx.product.findMany({ where: { id: { in: ids } } }) : []
      const byId = new Map(rows.map((r) => [r.id, r]))

      const blocked = norm
        .filter((n) => n.productId != null)
        .map((n) => byId.get(n.productId))
        .filter((p) => !p || !p.is_active)
      if (blocked.length) {
        throw Object.assign(
          new Error(`No longer stocked: ${blocked.map((p) => p?.name ?? 'unknown').join(', ')}`),
          { status: 400 }
        )
      }

      // ── Build line metadata and calculate subtotal ───────────────────────
      let subtotal = 0
      const lineMeta = norm.map((n) => {
        const product = n.productId != null ? byId.get(n.productId) : null
        let unit_price
        let unit_cost = 0

        if (product) {
          const tierPrice =
            n.tier === 'promotional' ? product.promotional_price
              : n.tier === 'wholesale' ? product.wholesale_price
                : product.normal_price
          unit_price = tierPrice > 0 ? tierPrice : product.normal_price
          unit_cost = 0
        } else {
          // Off-catalogue line: the price comes from the client, so it is the one
          // number here nobody has verified. Cap it and require a real name.
          if (!n.name) {
            throw Object.assign(new Error('Custom lines need a name'), { status: 400 })
          }
          if (n.clientPrice <= 0) {
            throw Object.assign(
              new Error(`"${n.name}" needs a price greater than 0`),
              { status: 400 }
            )
          }
          if (n.clientPrice > OFF_CATALOGUE_PRICE_CAP) {
            throw Object.assign(
              new Error(`Off-catalogue lines are capped at ${OFF_CATALOGUE_PRICE_CAP} — add "${n.name}" to the catalogue instead`),
              { status: 400 }
            )
          }
          unit_price = n.clientPrice
        }

        const gross = unit_price * n.quantity
        subtotal += gross

        return {
          productId: n.productId,
          name: product ? product.name : n.name,
          quantity: n.quantity,
          unit_price,
          unit_cost,
          price_tier: n.tier,
          batch_id: null, // ← will be filled after stock deduction
        }
      })

      // ── Validate discount ────────────────────────────────────────────────
      const disc = discount_amount
      if (disc > subtotal) {
        throw Object.assign(new Error('Discount cannot exceed the sale total'), { status: 400 })
      }
      if (disc > 0 && (!discount_reason || !String(discount_reason).trim())) {
        throw Object.assign(new Error('A reason is required for every discount'), { status: 400 })
      }

      const total = subtotal - disc

      const { hasCredit } = validatePaymentLines(payments, total)

      if (hasCredit && (!customer_phone?.trim() || customer_name === 'Walk-in Customer')) {
        throw Object.assign(new Error('Credit sales require a customer name and phone'), { status: 400 })
      }

      // ── Upsert customer and check their credit headroom ──────────────────
      let customer = null
      if (hasCredit) {
        const phone = customer_phone.trim()

        customer = await tx.pharmacyCustomer.upsert({
          where: { phone },
          update: {},
          create: { name: customer_name.trim(), phone },
        })

        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK.CUSTOMER}, ${customer.id})`

        const creditPortion = payments
          .filter((p) => p.method === 'credit')
          .reduce((s, p) => s + p.amount, 0)

        const [extended, repaid] = await Promise.all([
          tx.otcSalePayment.aggregate({
            where: { method: 'credit', sale: { customer_id: customer.id } },
            _sum: { amount: true },
          }),
          tx.customerPayment.aggregate({
            where: { customer_id: customer.id },
            _sum: { amount: true },
          }),
        ])

        const balance = (extended._sum.amount ?? 0) - (repaid._sum.amount ?? 0)
        const headroom = customer.credit_limit - balance

        if (customer.credit_limit <= 0) {
          throw Object.assign(
            new Error(`${customer.name} has no credit limit set — an admin must approve one first`),
            { status: 403 }
          )
        }
        if (creditPortion > headroom) {
          throw Object.assign(
            new Error(
              `Credit limit exceeded. ${customer.name} owes ${balance} of ${customer.credit_limit} — ` +
              `only ${Math.max(0, headroom)} available, ${creditPortion} requested`
            ),
            { status: 409 }
          )
        }
      }

      const displayMethod = hasCredit ? 'credit' : (payments[0]?.method || 'cash')

      // ── Create sale row (no items yet) ───────────────────────────────────
      const created = await tx.otcSale.create({
        data: {
          receipt_number: `OTC-TMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          customer_name: customer_name?.trim() || 'Walk-in Customer',
          payment_method: displayMethod,
          sold_by_id: currentUser?.id ?? null,
          customer_id: customer?.id ?? null,
          subtotal,
          tax_total: 0,
          total,
          discount_amount: disc,
          discount_reason: disc > 0 ? String(discount_reason).trim() : null,
          discount_by: disc > 0 ? currentUser?.username ?? null : null,
        },
      })

      // ── Deduct stock and attach batch info per line item ─────────────────
      const shortfalls = []

      for (let i = 0; i < lineMeta.length; i++) {
        const meta = lineMeta[i]
        if (meta.productId == null) continue

        const result = await takeStock(tx, {
          productId: meta.productId,
          quantity: meta.quantity,
          reason: 'sale',
          refType: 'otc_sale',
          refId: created.id,
          staffId: currentUser?.id,
        })

        if (result === null) {
          const row = byId.get(meta.productId)
          shortfalls.push({
            name: row?.name ?? meta.name,
            requested: meta.quantity,
            available: row?.current_stock ?? 0,
          })
        } else {
          meta.batch_id = result.batches_used?.[0]?.batch_id ?? null
        }
      }

      if (shortfalls.length) throw new ShortfallError(shortfalls)

      // ── Create items with batch IDs ──────────────────────────────────────
      await tx.otcSaleItem.createMany({
        data: lineMeta.map((meta) => ({
          sale_id: created.id,
          product_id: meta.productId,
          name: meta.name,
          quantity: meta.quantity,
          unit_price: meta.unit_price,
          unit_cost: meta.unit_cost,
          price_tier: meta.price_tier,
          product_batch_id: meta.batch_id,
        })),
      })

      // ── Create payment lines ─────────────────────────────────────────────
      await tx.otcSalePayment.createMany({
        data: payments.map((p) => ({
          sale_id: created.id,
          method: p.method,
          amount: parseInt(p.amount) || 0,
          reference: (typeof p.reference === 'string' && p.reference.trim()) || null,
        })),
      })

      // ── Finalize receipt number ──────────────────────────────────────────
      return tx.otcSale.update({
        where: { id: created.id },
        data: { receipt_number: `OTC-${String(created.id).padStart(5, '0')}` },
        include: {
          items: { include: { product: { select: { category: true, unit: true } } } },
          payments: true,
          customer: { select: { id: true, name: true, phone: true } },
          sold_by_staff: { select: { username: true } },
        },
      })
    }, { timeout: 15000 })

    const customLines = sale.items.filter((i) => i.product_id == null)

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'otc_sale',
      description:
        `OTC sale ${sale.receipt_number} — ${sale.items.length} line(s), total ${sale.total}` +
        (sale.discount_amount > 0 ? `, discount ${sale.discount_amount}` : '') +
        (customLines.length
          ? ` — ${customLines.length} off-catalogue line(s): ${customLines.map((i) => `${i.name} @ ${i.unit_price}`).join(', ')}`
          : ''),
      category: 'sale',
      entity: 'otc_sale',
      entityId: sale.id,
      ipAddress: req.ip ?? null,
    })

    res.json({ success: true, sale: shapeSale(sale) })
  } catch (err) {
    if (err instanceof ShortfallError) {
      return res.status(409).json({ error: 'Insufficient stock', shortfalls: err.shortfalls })
    }
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('createOtcSale', err)
    res.status(500).json({ error: 'Failed to create OTC sale' })
  }
}

// ─── Returns ─────────────────────────────────────────────────────────────────

const RETURN_WINDOW_DAYS = 7

function sameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// POST /api/pharmacy/otc-sales/:id/return
exports.createSaleReturn = async (req, res) => {
  const saleId = parseInt(req.params.id)
  const currentUser = req.user
  const { reason, lines, reference } = req.body

  if (!Number.isInteger(saleId)) {
    return res.status(400).json({ error: 'Sale ID is required' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the sale so two returns can't both pass the quantity check.
      await tx.$executeRaw`SELECT id FROM otc_sales WHERE id = ${saleId} FOR UPDATE`

      const sale = await tx.otcSale.findUnique({
        where: { id: saleId },
        include: {
          items: true,
          payments: true,
          customer: { select: { id: true, name: true } },
          returns: { include: { items: true } },
        },
      })
      if (!sale) throw Object.assign(new Error('Sale not found'), { status: 404 })

      // ── Window ────────────────────────────────────────────────────────────
      const now = new Date()
      const soldAt = new Date(sale.sold_at)
      const ageDays = Math.floor((now - soldAt) / 86400000)
      const isAdmin = currentUser?.role === 'admin'

      if (!isAdmin && !sameCalendarDay(now, soldAt)) {
        throw Object.assign(
          new Error('Pharmacists can only process returns on the day of sale — an admin must handle this one'),
          { status: 403 }
        )
      }
      if (ageDays > RETURN_WINDOW_DAYS) {
        throw Object.assign(
          new Error(`This sale is ${ageDays} days old — returns close after ${RETURN_WINDOW_DAYS} days`),
          { status: 403 }
        )
      }

      // ── Validate the requested lines against what's left ──────────────────
      const itemById = new Map(sale.items.map((i) => [i.id, i]))

      const alreadyReturned = new Map()
      for (const r of sale.returns) {
        for (const ri of r.items) {
          alreadyReturned.set(ri.sale_item_id, (alreadyReturned.get(ri.sale_item_id) || 0) + ri.quantity)
        }
      }

      let refundTotal = 0
      const planned = []

      for (const l of lines) {
        const item = itemById.get(l.sale_item_id)
        if (!item) {
          throw Object.assign(
            new Error(`Line ${l.sale_item_id} does not belong to this sale`),
            { status: 400 }
          )
        }
        const returnable = item.quantity - (alreadyReturned.get(item.id) || 0)
        if (l.quantity > returnable) {
          throw Object.assign(
            new Error(
              returnable === 0
                ? `${item.name} has already been fully returned`
                : `Only ${returnable} of ${item.name} left to return`
            ),
            { status: 409 }
          )
        }
        refundTotal += item.unit_price * l.quantity
        planned.push({ item, quantity: l.quantity, disposition: l.disposition, note: l.note ?? null })
      }

      if (planned.length === 0) {
        throw Object.assign(new Error('Select at least one line to return'), { status: 400 })
      }

      // A discount was applied to the sale as a whole, so a returned line is
      // worth its share of the discounted total, not its full list price.
      const grossSubtotal = sale.subtotal || 0
      if (sale.discount_amount > 0 && grossSubtotal > 0) {
        refundTotal = Math.round(refundTotal * (sale.total / grossSubtotal))
      }

      // ── Split the refund: outstanding credit first, then cash ─────────────
      // You don't hand notes to someone who still owes you for this sale.
      const creditOnSale = sale.payments
        .filter((p) => p.method === 'credit')
        .reduce((s, p) => s + p.amount, 0)

      const alreadyCreditNoted = sale.returns.reduce((s, r) => s + r.credit_note_amount, 0)

      const creditRemaining = Math.max(0, creditOnSale - alreadyCreditNoted)
      const creditNoteAmount = Math.min(refundTotal, creditRemaining)
      const cashAmount = refundTotal - creditNoteAmount

      // ── Record the return ─────────────────────────────────────────────────
      const created = await tx.otcSaleReturn.create({
        data: {
          return_number: `RTN-TMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          sale_id: saleId,
          reason: reason.trim(),
          cash_refund_amount: cashAmount,
          credit_note_amount: creditNoteAmount,
          reference: reference?.trim() || null,
          returned_by_id: currentUser?.id ?? null,
          returned_by: currentUser?.username ?? null,
        },
      })

      // ── Stock: restock goes back to its original batch, writeoff doesn't ──
      for (const p of planned) {
        if (p.item.product_id == null) continue

        if (p.disposition === 'restock') {
          await giveStock(tx, {
            productId: p.item.product_id,
            batch_id: p.item.product_batch_id ?? null,
            quantity: p.quantity,
            reason: 'return_to_stock',
            refType: 'otc_sale_return',
            refId: created.id,
            staffId: currentUser?.id,
            note: `Returned from ${sale.receipt_number}`,
          })
        } else {
          await tx.stockMovement.create({
            data: {
              product_id: p.item.product_id,
              batch_id: p.item.product_batch_id ?? null,
              delta: 0,
              reason: 'writeoff',
              ref_type: 'otc_sale_return',
              ref_id: created.id,
              balance_after: (await tx.product.findUnique({
                where: { id: p.item.product_id },
                select: { current_stock: true },
              })).current_stock,
              staff_id: currentUser?.id ?? null,
              note:
                `${p.quantity} × ${p.item.name} returned unsaleable from ` +
                `${sale.receipt_number}${p.note ? ` — ${p.note}` : ''}`,
            },
          })
        }
      }

      await tx.otcSaleReturnItem.createMany({
        data: planned.map((p) => ({
          return_id: created.id,
          sale_item_id: p.item.id,
          quantity: p.quantity,
          unit_price: p.item.unit_price,
          disposition: p.disposition,
          note: p.note,
        })),
      })

      // ── Credit note: reduces the customer's debt, no money moves ──────────
      if (creditNoteAmount > 0) {
        if (!sale.customer_id) {
          throw Object.assign(
            new Error('This sale has a credit portion but no linked customer — cannot issue a credit note'),
            { status: 422 }
          )
        }
        await tx.customerPayment.create({
          data: {
            customer_id: sale.customer_id,
            amount: creditNoteAmount,
            method: 'credit_note',
            reference: `Return ${created.id} against ${sale.receipt_number}`,
            staff_id: currentUser?.id ?? null,
            is_credit_note: true,
          },
        })
      }

      const finalised = await tx.otcSaleReturn.update({
        where: { id: created.id },
        data: { return_number: `RTN-${String(created.id).padStart(5, '0')}` },
        include: { items: true },
      })

      return { sale, ret: finalised, planned, refundTotal, creditNoteAmount, cashAmount }
    }, { timeout: 15000 })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'otc_return',
      description:
        `Return ${result.ret.return_number} against ${result.sale.receipt_number} — ` +
        `${result.planned.map((p) => `${p.quantity} × ${p.item.name} (${p.disposition})`).join(', ')}. ` +
        `Refund ${result.refundTotal}` +
        (result.creditNoteAmount > 0 ? `: ${result.creditNoteAmount} credit note` : '') +
        (result.cashAmount > 0 ? `${result.creditNoteAmount > 0 ? ' + ' : ': '}${result.cashAmount} cash` : '') +
        `. Reason: ${result.ret.reason}`,
      category: 'sale',
      entity: 'otc_sale_return',
      entityId: result.ret.id,
      ipAddress: req.ip ?? null,
    })

    emit('sale:returned', { saleId, returnId: result.ret.id }, 'admin')

    return res.status(201).json({
      success: true,
      return: {
        id: result.ret.id,
        return_number: result.ret.return_number,
        refund_amount: result.refundTotal,
        credit_note_amount: result.creditNoteAmount,
        cash_refund_amount: result.cashAmount,
        reason: result.ret.reason,
        created_at: result.ret.created_at,
      },
    })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('createSaleReturn', err)
    return res.status(500).json({ error: 'Failed to process return' })
  }
}



// ─── GET OTC SALES (update your include) ──────────────────────────────────────
exports.getOtcSales = async (req, res) => {
  try {
    const {
      q,
      from,
      to,
      payment_method,
      page = '1',
      limit = '20',
    } = req.query
    const pageNum = Math.max(1, parseInt(page) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20))
    const skip = (pageNum - 1) * limitNum

    const where = {}

    if (from || to) {
      const range = {}
      if (from) {
        const start = new Date(from)
        if (Number.isNaN(start.getTime())) {
          return res.status(400).json({ error: 'Invalid from date' })
        }
        start.setHours(0, 0, 0, 0)
        range.gte = start
      }
      if (to) {
        const end = new Date(to)
        if (Number.isNaN(end.getTime())) {
          return res.status(400).json({ error: 'Invalid to date' })
        }
        end.setHours(0, 0, 0, 0)
        end.setDate(end.getDate() + 1)   // exclusive upper bound
        range.lt = end
      }
      where.sold_at = range
    }

    // Filter on the payment lines, not OtcSale.payment_method — that scalar
    // reads 'credit' for any split sale containing a credit portion.
    if (payment_method && payment_method !== 'all') {
      where.payments = { some: { method: payment_method } }
    }

    const term = typeof q === 'string' ? q.trim() : ''
    if (term) {
      where.OR = [
        { receipt_number: { contains: term, mode: 'insensitive' } },
        { customer_name: { contains: term, mode: 'insensitive' } },
        { customer: { phone: { contains: term, mode: 'insensitive' } } },
        { items: { some: { name: { contains: term, mode: 'insensitive' } } } },
      ]
    }

    const todayStart = new Date(new Date().setHours(0, 0, 0, 0))

    const [sales, total, totalAgg, todayAgg] = await Promise.all([
      prisma.otcSale.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { sold_at: 'desc' },
        include: {
          items: { include: { product: { select: { category: true, unit: true } } } },
          sold_by_staff: { select: { username: true } },
          payments: true,
          customer: { select: { id: true, name: true, phone: true } },
          returns: { include: { items: true } },
        },
      }),
      prisma.otcSale.count({ where }),
      // Stats are all-time, independent of the filter — they describe the
      // business, not the current search.
      prisma.otcSale.aggregate({ _sum: { total: true }, _count: true }),
      prisma.otcSale.aggregate({
        where: { sold_at: { gte: todayStart } },
        _sum: { total: true },
        _count: true,
      }),
    ])

    return res.json({
      sales: sales.map(shapeSale),
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      stats: {
        total_sales: totalAgg._count,
        total_revenue: totalAgg._sum.total || 0,
        today_count: todayAgg._count,
        today_revenue: todayAgg._sum.total || 0,
      },
    })
  } catch (err) {
    console.error('getOtcSales', err.message)
    return res.status(500).json({ error: 'Failed to fetch OTC sales' })
  }
}

exports.getInternalOrders = async (req, res) => {
  try {
    const { department, status, from, to } = req.query
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)

    // Existing callers that do not supply a limit still receive up to 200 rows.
    // The admin dashboard supplies limit=20 and uses the pagination fields below.
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 200)
    )

    const where = {}
    if (ORDER_DEPARTMENTS.includes(department)) where.department = department
    if (['pending', 'fulfilled', 'cancelled'].includes(status)) where.status = status

    // A requested-date range is inclusive of both calendar dates. Keep this
    // parsing aligned with the existing finance endpoints in admin_controller.
    if (from || to) {
      if (!from || !to) {
        return res.status(400).json({ error: 'Both from and to dates are required' })
      }

      const start = new Date(from)
      const end = new Date(to)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
        return res.status(400).json({ error: 'Invalid requested-date range' })
      }

      start.setHours(0, 0, 0, 0)
      end.setHours(0, 0, 0, 0)
      end.setDate(end.getDate() + 1) // exclusive upper bound; includes the whole "to" date
      where.requested_at = { gte: start, lt: end }
    }

    const [orders, total, statusGroups] = await prisma.$transaction([
      prisma.pharmacyOrder.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { requested_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.pharmacyOrder.count({ where }),
      // These remain overall counts, so the status chips remain useful even
      // when the administrator filters to Doctor or Lab requests.
      prisma.pharmacyOrder.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ])

    const counts = Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all])
    )
    const allOrders = Object.values(counts).reduce((sum, count) => sum + count, 0)

    return res.json({
      orders: orders.map(shapeOrder),
      stats: {
        pending: counts.pending ?? 0,
        fulfilled: counts.fulfilled ?? 0,
        cancelled: counts.cancelled ?? 0,
        total: allOrders,
      },
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    })
  } catch (err) {
    console.error('getInternalOrders', err.message)
    return res.status(500).json({ error: 'Failed to fetch orders' })
  }
}

exports.createInternalOrder = async (req, res) => {
  const currentUser = req.user
  const { items, notes } = req.body

  const ROLE_TO_DEPT = {
    doctor: 'doctor',
    lab_tech: 'lab',
  }
  const department = ROLE_TO_DEPT[currentUser?.role]
  if (!department || !ORDER_DEPARTMENTS.includes(department)) {
    return res.status(403).json({ error: 'Your role cannot create supply orders' })
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Add at least one item to the order' })
  }

  const norm = []
  for (const i of items) {
    const quantity = parseInt(i.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'Each item needs a positive whole-number quantity' })
    }
    const rawId = i.product_id
    const productId = rawId != null && rawId !== '' ? parseInt(rawId) : null
    const name = typeof i.name === 'string' ? i.name.trim() : ''
    if (productId == null && !name) {
      return res.status(400).json({ error: 'Each item needs a product or a name' })
    }
    norm.push({
      productId: Number.isInteger(productId) ? productId : null,
      name,
      quantity,
      notes: (typeof i.notes === 'string' && i.notes.trim()) || null,
    })
  }

  try {
    const ids = norm.filter((n) => n.productId != null).map((n) => n.productId)
    const products = ids.length
      ? await prisma.product.findMany({ where: { id: { in: ids } } })
      : []
    const byId = new Map(products.map((p) => [p.id, p]))

    const missing = norm
      .filter((n) => n.productId != null && !byId.has(n.productId))
    if (missing.length) {
      return res.status(400).json({ error: 'One or more items are not in the stock' })
    }

    const inactive = norm
      .filter((n) => n.productId != null && !byId.get(n.productId).is_active)
    if (inactive.length) {
      return res.status(400).json({
        error: `No longer stocked: ${inactive.map((n) => byId.get(n.productId).name).join(', ')}`,
      })
    }

    // The control. Enforced here, not in the picker — the picker is a
    // convenience, this is what actually stops it.
    const meds = norm
      .filter((n) => n.productId != null && byId.get(n.productId).category === MEDICATION)
    if (meds.length) {
      return res.status(400).json({
        error: `Medications cannot be ordered as supplies — prescribe them instead: ${meds.map((n) => byId.get(n.productId).name).join(', ')}`,
      })
    }

    const order = await prisma.pharmacyOrder.create({
      data: {
        department,
        requested_by: currentUser?.username ?? 'Unknown',
        requested_by_id: currentUser?.id ?? null,
        status: 'pending',
        notes: (typeof notes === 'string' && notes.trim()) || null,
        items: {
          create: norm.map((n) => ({
            product_id: n.productId,
            // Snapshot the catalogue name so the line reads correctly even
            // after a rename or a delete.
            name: n.productId != null ? byId.get(n.productId).name : n.name,
            quantity: n.quantity,
            notes: n.notes,
          })),
        },
      },
      include: ORDER_INCLUDE,
    })

    await createNotification({
      targetRoles: ['pharmacist'],
      type: NOTIFICATION_TYPES.ORDER_NEW,
      title: 'New supply order',
      message: `${currentUser?.username} (${department}) requested ${order.items.length} item(s) from the pharmacy.`,
      io: safeIO(),
    })
    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'create_supply_order',
      description: `Raised supply order #${order.id} for ${department} (${order.items.length} line(s))`,
      category: 'order',
      entity: 'pharmacy_order',
      entityId: order.id,
      ipAddress: req.ip ?? null,
    })

    emit('order:new', {}, 'pharmacist')
    res.status(201).json({ success: true, order: shapeOrder(order) })
  } catch (err) {
    console.error('createInternalOrder', err.message)
    res.status(500).json({ error: 'Failed to create order' })
  }
}


exports.fulfillOrder = async (req, res) => {
  const id = parseInt(req.params.id)
  const currentUser = req.user
  const { lines } = req.body || {}

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Order ID is required' })
  }

  try {
    const order = await prisma.pharmacyOrder.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    })
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order is already ${order.status}` })
    }

    // item_id → quantity actually handed over
    const requestedByItem = new Map()
    if (Array.isArray(lines) && lines.length) {
      for (const l of lines) {
        const itemId = parseInt(l.item_id)
        const qty = parseInt(l.quantity)
        if (!Number.isInteger(itemId) || !Number.isInteger(qty) || qty < 0) {
          return res.status(400).json({
            error: 'Each line needs an item_id and a quantity of 0 or more',
          })
        }
        requestedByItem.set(itemId, qty)
      }
    }

    const plan = order.items.map((it) => ({
      item: it,
      qty: requestedByItem.has(it.id) ? requestedByItem.get(it.id) : it.quantity,
    }))

    for (const p of plan) {
      if (p.qty > p.item.quantity) {
        return res.status(400).json({
          error: `Cannot issue more than requested for ${p.item.name} (asked ${p.item.quantity})`,
        })
      }
    }
    if (plan.every((p) => p.qty === 0)) {
      return res.status(400).json({ error: 'Nothing to hand over — every line is zero' })
    }

    const now = new Date()

    const updated = await prisma.$transaction(async (tx) => {
      const shortfalls = []

      for (const { item, qty } of plan) {
        if (qty > 0 && item.product_id != null) {
          const balance = await takeStock(tx, {
            productId: item.product_id,
            quantity: qty,
            reason: 'issue',
            refType: 'pharmacy_order',
            refId: id,
            staffId: currentUser?.id,
            note: `Issued to ${order.department} (${order.requested_by})`,
          })
          if (balance === null) {
            const row = await tx.product.findUnique({ where: { id: item.product_id } })
            shortfalls.push({
              item_id: item.id,
              name: item.name,
              requested: qty,
              available: row?.current_stock ?? 0,
            })
            continue
          }
        }

        await tx.pharmacyOrderItem.update({
          where: { id: item.id },
          data: { fulfilled_qty: qty },
        })
      }

      if (shortfalls.length) throw new ShortfallError(shortfalls)

      return tx.pharmacyOrder.update({
        where: { id },
        data: {
          status: 'fulfilled',
          fulfilled_by: currentUser?.username ?? null,
          fulfilled_by_id: currentUser?.id ?? null,
          fulfilled_at: now,
        },
        include: ORDER_INCLUDE,
      })
    })

    const roleMap = {
      doctor: 'doctor', lab: 'lab_tech',
    }
    const targetRoles = roleMap[order.department]
      ? [roleMap[order.department]]
      : ['doctor', 'lab_tech']

    await createNotification({
      targetRoles,
      type: NOTIFICATION_TYPES.ORDER_FULFILLED,
      title: 'Supply order ready',
      message: `Supply order #${id} requested by ${order.requested_by} is ready for pickup.`,
      io: safeIO(),
    })

    try {
      const issued = plan.reduce((s, p) => s + p.qty, 0)
      const asked = plan.reduce((s, p) => s + p.item.quantity, 0)
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'fulfill_order',
        description: `Fulfilled supply order #${id} for ${order.department} (${order.requested_by}) — issued ${issued} of ${asked} units`,
        category: 'order',
        entity: 'pharmacy_order',
        entityId: id,
        ipAddress: req.ip ?? null,
      })
    } catch (e) { console.error('writeAuditLog failed:', e.message) }

    emit('order:updated', { orderId: id, department: order.department, status: 'fulfilled' }, ['doctor', 'lab_tech'])

    res.json({ success: true, order: shapeOrder(updated) })
  } catch (err) {
    if (err instanceof ShortfallError) {
      return res.status(409).json({
        error: 'Not enough stock to issue one or more lines — reduce the quantity or restock first',
        shortfalls: err.shortfalls,
      })
    }
    console.error('fulfillOrder', err.message)
    res.status(500).json({ error: 'Failed to fulfil order' })
  }
}

exports.cancelOrder = async (req, res) => {
  const id = parseInt(req.params.id)
  const { reason } = req.body || {}
  const currentUser = req.user

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Order ID is required' })
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required to cancel an order' })
  }

  try {
    const order = await prisma.pharmacyOrder.findUnique({ where: { id } })
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order is already ${order.status}` })
    }

    const updated = await prisma.pharmacyOrder.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelled_by: currentUser?.username ?? null,
        cancelled_at: new Date(),
        cancel_reason: String(reason).trim(),
      },
      include: ORDER_INCLUDE,
    })

    const roleMap = {
      doctor: 'doctor', lab: 'lab_tech',
    }
    await createNotification({
      targetRoles: roleMap[order.department]
        ? [roleMap[order.department]]
        : ['doctor', 'lab_tech'],
      type: NOTIFICATION_TYPES.ORDER_CANCELLED,
      title: 'Supply order cancelled',
      message: `Supply order #${id} was cancelled by the pharmacy. Reason: ${String(reason).trim()}`,
      io: safeIO(),
    })
    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'cancel_order',
      description: `Cancelled supply order #${id} for ${order.department}`,
      category: 'order',
      entity: 'pharmacy_order',
      entityId: id,
      ipAddress: req.ip ?? null,
    })

    emit('order:updated', { orderId: id, department: order.department, status: 'cancelled' }, ['lab_tech', 'doctor'])

    res.json({ success: true, order: shapeOrder(updated) })
  } catch (err) {
    console.error('cancelOrder', err.message)
    res.status(500).json({ error: 'Failed to cancel order' })
  }
}

exports.getProductMovements = async (req, res) => {
  const id = parseInt(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Product ID is required' })

  try {
    const [product, movements] = await Promise.all([
      prisma.product.findUnique({
        where: { id },
        select: {
          id: true, name: true, unit: true, current_stock: true,
          category: true, sub_category: true,
        },
      }),
      prisma.stockMovement.findMany({
        where: { product_id: id },
        include: { staff: { select: { username: true } } },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
    ])
    if (!product) return res.status(404).json({ error: 'Product not found' })

    res.json({
      product,
      movements: movements.map((m) => ({
        id: m.id,
        delta: m.delta,
        reason: m.reason,
        ref_type: m.ref_type,
        ref_id: m.ref_id,
        balance_after: m.balance_after,
        note: m.note,
        staff: m.staff?.username ?? null,
        created_at: m.created_at,
      })),
    })
  } catch (err) {
    console.error('getProductMovements', err)
    res.status(500).json({ error: 'Failed to fetch stock movements' })
  }
}

exports.getCustomers = async (req, res) => {
  try {
    const { q } = req.query
    const where = {}
    if (typeof q === 'string' && q.trim()) {
      const term = q.trim()
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ]
    }

    const customers = await prisma.pharmacyCustomer.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { id: true, name: true, phone: true, credit_limit: true },
    })

    if (customers.length === 0) return res.json({ customers: [] })

    const ids = customers.map((c) => c.id)

    // Balance is derived: credit extended minus repayments. Credit lines are
    // never mutated when a customer pays.
    const [creditRows, paymentRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT s.customer_id, SUM(sp.amount)::int AS total_credit
        FROM otc_sale_payments sp
        JOIN otc_sales s ON s.id = sp.sale_id
        WHERE sp.method = 'credit' AND s.customer_id = ANY(${ids})
        GROUP BY s.customer_id
      `,
      prisma.customerPayment.groupBy({
        by: ['customer_id'],
        where: { customer_id: { in: ids } },
        _sum: { amount: true },
      }),
    ])

    const creditById = new Map(creditRows.map((r) => [r.customer_id, r.total_credit]))
    const paidById = new Map(paymentRows.map((p) => [p.customer_id, p._sum.amount ?? 0]))

    return res.json({
      customers: customers.map((c) => {
        const balance = Math.max(0, (creditById.get(c.id) ?? 0) - (paidById.get(c.id) ?? 0))
        return {
          ...c,
          balance,
          headroom: Math.max(0, c.credit_limit - balance),
        }
      }),
    })
  } catch (err) {
    console.error('getCustomers', err.message)
    return res.status(500).json({ error: 'Failed to fetch customers' })
  }
}

exports.updateShelfLocation = async (req, res) => {
  try {
    const id = req.params.id

    const { shelf_location } = req.body
    if (shelf_location === undefined) {
      return res.status(400).json({ error: 'shelf_location is required' })
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        shelf_location: String(shelf_location).trim() || null,
      },
    })

    res.json({
      success: true,
      product: {
        id: updated.id,
        shelf_location: updated.shelf_location,
      },
    })
  } catch (err) {
    console.error('PATCH /pharmacy/stock/:id error:', err.message)
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Product not found' })
    }
    res.status(500).json({ error: 'Failed to update shelf location' })
  }
}

// ─── Stocktake ───────────────────────────────────────────────────────────────

exports.createStocktake = async (req, res) => {
  const currentUser = req.user
  const { label, shelf_from, shelf_to, blind } = req.body || {}
  const size = Math.min(
    STOCKTAKE_MAX_SIZE,
    Math.max(1, parseInt(req.body?.size, 10) || STOCKTAKE_WORKLIST_SIZE)
  )

  try {
    const open = await prisma.stocktakeSession.findFirst({
      where: { status: { in: ['in_progress', 'submitted'] } },
      select: { id: true, label: true, status: true },
    })
    if (open) {
      return res.status(409).json({
        error: `"${open.label}" is still ${open.status.replace('_', ' ')} — finish it before starting another`,
        session_id: open.id,
      })
    }

    const where = { is_active: true }
    if (shelf_from && shelf_to) {
      where.shelf_location = { gte: String(shelf_from), lte: String(shelf_to) }
    }

    const products = await prisma.product.findMany({
      where,
      orderBy: [{ last_counted_at: { sort: 'asc', nulls: 'first' } }, { shelf_location: 'asc' }],
      take: size,
      select: { id: true, shelf_location: true },
    })
    if (products.length === 0) {
      return res.status(400).json({ error: 'No products match this scope' })
    }

    const session = await prisma.stocktakeSession.create({
      data: {
        label: (typeof label === 'string' && label.trim())
          || `Count — ${new Date().toISOString().slice(0, 10)}`,
        blind: blind !== false,
        started_by: currentUser?.username ?? 'Pharmacist',
        started_by_id: currentUser?.id ?? null,
        items: {
          create: products.map((p) => ({
            product_id: p.id,
            shelf_location: p.shelf_location,
          })),
        },
      },
      include: STOCKTAKE_INCLUDE,
    })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'Stocktake Started',
      description: `Started "${session.label}" — ${products.length} product(s)${session.blind ? ', blind' : ', UNBLIND'}`,
      category: 'stock',
      entity: 'StocktakeSession',
      entityId: session.id,
      ipAddress: req.ip ?? null,
    })

    const hide = session.blind
    return res.status(201).json({
      success: true,
      session: {
        ...shapeStocktakeMeta(session),
        items: session.items.map((i) => shapeStocktakeItem(i, hide)),
        stats: hide ? stocktakeProgress(session.items) : summariseStocktake(session.items),
      },
    })
  } catch (err) {
    console.error('createStocktake', err.message)
    return res.status(500).json({ error: 'Failed to start stocktake' })
  }
}

exports.getStocktakes = async (req, res) => {
  try {
    const sessions = await prisma.stocktakeSession.findMany({
      orderBy: { started_at: 'desc' },
      take: 50,
    })
    if (sessions.length === 0) return res.json({ sessions: [] })

    const ids = sessions.map((s) => s.id)
    const stats = await prisma.$queryRaw`
      SELECT session_id,
             COUNT(*)::int                                                      AS total_items,
             COUNT(counted_at)::int                                             AS counted_items,
             COUNT(*) FILTER (WHERE variance IS NOT NULL AND variance <> 0)::int AS discrepancy_count,
             COALESCE(SUM(variance) FILTER (WHERE variance < 0), 0)::int         AS total_missing,
             COALESCE(SUM(variance) FILTER (WHERE variance > 0), 0)::int         AS total_found
      FROM stocktake_items
      WHERE session_id = ANY(${ids})
      GROUP BY session_id
    `
    const byId = new Map(stats.map((s) => [s.session_id, s]))

    return res.json({
      sessions: sessions.map((s) => {
        const st = byId.get(s.id) ?? {}
        const hide = s.status === 'in_progress' && s.blind
        return {
          ...shapeStocktakeMeta(s),
          stats: {
            total_items: st.total_items ?? 0,
            counted_items: st.counted_items ?? 0,
            uncounted_items: (st.total_items ?? 0) - (st.counted_items ?? 0),
            ...(hide ? {} : {
              discrepancy_count: st.discrepancy_count ?? 0,
              total_missing: st.total_missing ?? 0,
              total_found: st.total_found ?? 0,
            }),
          },
        }
      }),
    })
  } catch (err) {
    console.error('getStocktakes', err.message)
    return res.status(500).json({ error: 'Failed to fetch stocktakes' })
  }
}

exports.getStocktake = async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Session ID is required' })

  try {
    const session = await prisma.stocktakeSession.findUnique({
      where: { id },
      include: STOCKTAKE_INCLUDE,
    })
    if (!session) return res.status(404).json({ error: 'Stocktake not found' })

       const hide = session.blind && session.status === 'in_progress'

    // What trading did to each product since its own line was counted. This
    // does not enter the arithmetic — shelf and system move together, so the
    // variance is unchanged — but a large figure is a reason to look harder.
    let movedByItem = new Map()
    if (!hide) {
      const rows = await prisma.$queryRaw`
        SELECT si.id                          AS item_id,
               COALESCE(SUM(sm.delta), 0)::int AS net,
               COUNT(sm.id)::int               AS movements,
               MAX(sm.created_at)              AS last_moved_at
        FROM stocktake_items si
        JOIN stock_movements sm
          ON sm.product_id = si.product_id
         AND sm.created_at > si.counted_at
         AND sm.delta <> 0
         AND sm.reason <> 'stocktake'
        WHERE si.session_id = ${id} AND si.counted_at IS NOT NULL
        GROUP BY si.id
      `
      movedByItem = new Map(rows.map((r) => [r.item_id, r]))
    }

    return res.json({
      session: {
        ...shapeStocktakeMeta(session),
        items: session.items.map((i) => shapeStocktakeItem(i, hide, movedByItem.get(i.id))),
        stats: hide ? stocktakeProgress(session.items) : summariseStocktake(session.items),
      },
    })
  } catch (err) {
    console.error('getStocktake', err.message)
    return res.status(500).json({ error: 'Failed to fetch stocktake' })
  }
}

exports.recordStocktakeCount = async (req, res) => {
  const sessionId = parseInt(req.params.id, 10)
  const itemId = parseInt(req.params.itemId, 10)
  const currentUser = req.user
  const { counted_qty, reason, note } = req.body || {}

  if (!Number.isInteger(sessionId) || !Number.isInteger(itemId)) {
    return res.status(400).json({ error: 'Session and item IDs are required' })
  }

  const hasCount = counted_qty !== undefined
  const qty = hasCount && counted_qty !== null && counted_qty !== ''
    ? Number(counted_qty)
    : null

  if (hasCount && qty !== null && (!Number.isInteger(qty) || qty < 0)) {
    return res.status(400).json({ error: 'Counted quantity must be a whole number of 0 or more' })
  }
  if (reason !== undefined && reason !== null && reason !== '' && !STOCKTAKE_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'Unknown reason' })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.stocktakeSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, blind: true },
      })
      if (!session) throw httpError('Stocktake not found', 404)
      if (session.status === 'approved') {
        throw httpError('This stocktake has been approved and can no longer be edited', 409)
      }
      if (hasCount && session.status !== 'in_progress') {
        throw httpError('Counts are locked once the stocktake is submitted', 409)
      }

           const item = await tx.stocktakeItem.findUnique({
        where: { id: itemId },
        select: {
          id: true, session_id: true, product_id: true,
          counted_at: true, counted_qty: true, posted_at: true,
        },
      })
      if (!item || item.session_id !== sessionId) {
        throw httpError('Item does not belong to this stocktake', 404)
      }
      // A partly approved session reopens for recount. Lines whose adjustment
      // already moved stock must not be edited, or the recount would change a
      // variance that has been posted.
      if (item.posted_at != null) {
        throw httpError('This line has already been adjusted and can no longer be edited', 409)
      }

      const data = {}

      if (hasCount) {
        if (qty === null) {
          // Clearing returns the line to uncounted rather than recording a zero.
          Object.assign(data, {
            counted_qty: null, system_qty: null, variance: null,
            counted_at: null, counted_by: null, reason: null,
          })
        } else {
          // The system figure is read HERE, under the lock, in the same
          // transaction as the count. This is what removes the drift window.
          await lockProduct(tx, item.product_id)

          const agg = await tx.productBatch.aggregate({
            where: { product_id: item.product_id },
            _sum: { quantity: true },
          })
          const systemQty = agg._sum.quantity ?? 0

          Object.assign(data, {
            counted_qty: qty,
            system_qty: systemQty,
            variance: qty - systemQty,
            counted_at: new Date(),
            counted_by: currentUser?.username ?? 'Pharmacist',
          })
          // A line corrected back to agreement keeps no stale reason.
          if (qty - systemQty === 0) data.reason = null
        }
      }

      if (reason !== undefined) data.reason = reason || null
      if (note !== undefined) data.note = (typeof note === 'string' && note.trim()) || null

      if (Object.keys(data).length === 0) throw httpError('Nothing to update')

      const updated = await tx.stocktakeItem.update({
        where: { id: itemId },
        data,
        include: {
          product: { select: { id: true, name: true, unit: true, category: true, normal_price: true } },
        },
      })

      return {
        session,
        updated,
        wasRecount: hasCount && item.counted_at != null,
        previous: item.counted_qty,
      }
    })

    if (result.wasRecount) {
      await writeAuditLog({
        staffId: currentUser?.id,
        user: currentUser?.username,
        action: 'Stocktake Line Recounted',
        description:
          `${result.updated.product.name} in stocktake #${sessionId}: ` +
          `${result.previous} → ${result.updated.counted_qty}`,
        category: 'stock',
        entity: 'StocktakeItem',
        entityId: itemId,
        ipAddress: req.ip ?? null,
      })
    }

    const hide = result.session.blind && result.session.status === 'in_progress'
    return res.json({ success: true, item: shapeStocktakeItem(result.updated, hide) })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('recordStocktakeCount', err.message)
    return res.status(500).json({ error: 'Failed to record count' })
  }
}

exports.submitStocktake = async (req, res) => {
  const id = parseInt(req.params.id, 10)
  const currentUser = req.user
  const { confirm_partial } = req.body || {}

  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Session ID is required' })

  try {
    const session = await prisma.stocktakeSession.findUnique({
      where: { id },
      include: STOCKTAKE_INCLUDE,
    })
    if (!session) return res.status(404).json({ error: 'Stocktake not found' })
    if (session.status !== 'in_progress') {
      return res.status(409).json({ error: `Stocktake is already ${session.status.replace('_', ' ')}` })
    }

    const counted = session.items.filter((i) => i.counted_at != null)
    if (counted.length === 0) {
      return res.status(400).json({ error: 'Count at least one product before submitting' })
    }

    const uncounted = session.items.length - counted.length
    if (uncounted > 0 && confirm_partial !== true) {
      return res.status(409).json({
        error:
          `${uncounted} product(s) were never counted. They will be left unadjusted, ` +
          `not written off. Resubmit with confirm_partial to continue.`,
        uncounted_count: uncounted,
        requires_confirmation: true,
      })
    }

    const updated = await prisma.stocktakeSession.update({
      where: { id },
      data: {
        status: 'submitted',
        submitted_by: currentUser?.username ?? 'Pharmacist',
        submitted_at: new Date(),
      },
      include: STOCKTAKE_INCLUDE,
    })
    const stats = summariseStocktake(updated.items)

    await createNotification({
      targetRoles: ['admin'],
      type: NOTIFICATION_TYPES.STOCKTAKE_SUBMITTED,
      title: 'Stocktake awaiting approval',
      message:
        `${currentUser?.username ?? 'Pharmacy'} submitted "${updated.label}" — ` +
        `${stats.counted_items} counted, ${stats.discrepancy_count} discrepanc${stats.discrepancy_count === 1 ? 'y' : 'ies'}, ` +
        `${Math.abs(stats.total_missing)} unit(s) missing.`,
      io: safeIO(),
    })

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'Stocktake Submitted',
      description:
        `Submitted "${updated.label}" — ${stats.counted_items}/${stats.total_items} counted, ` +
        `${stats.discrepancy_count} discrepancies, ${Math.abs(stats.total_missing)} missing, ` +
        `${stats.total_found} found`,
      category: 'stock',
      entity: 'StocktakeSession',
      entityId: id,
      ipAddress: req.ip ?? null,
    })

    emit('stocktake:submitted', { sessionId: id }, 'admin')

    // Variances are revealed here. This is where the pharmacist annotates
    // discrepant lines — a blind counter could not do that earlier.
    return res.json({
      success: true,
      session: {
        ...shapeStocktakeMeta(updated),
        items: updated.items.map((i) => shapeStocktakeItem(i, false)),
        stats,
      },
    })
  } catch (err) {
    console.error('submitStocktake', err.message)
    return res.status(500).json({ error: 'Failed to submit stocktake' })
  }
}