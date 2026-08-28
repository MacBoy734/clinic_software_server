

const prisma = require('../lib/prisma')

const { getIO } = require('../utils/socket')
const { createNotification, writeAuditLog, NOTIFICATION_TYPES, validatePaymentLines, recomputeMedicationFee } = require('../utils/helpers')


const CATEGORIES = ['medication', 'consumable', 'general']

const MEDICATION = 'medication'

const SUPPLY_CATEGORIES = CATEGORIES.filter((c) => c !== MEDICATION)

const PRICE_TIERS = ['normal', 'promotional', 'wholesale']
const ORDER_DEPARTMENTS = ['doctor', 'lab', 'admin']

exports.CATEGORIES = CATEGORIES
exports.MEDICATION = MEDICATION
exports.SUPPLY_CATEGORIES = SUPPLY_CATEGORIES


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


async function takeStock(tx, { productId, quantity, reason, refType, refId, staffId, note }) {
  if (!productId || !quantity || quantity <= 0) return null

  // Serialize all stock operations on this product
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productId})`

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

  // Legacy fallback: no batch records yet
  if (batches.length === 0) {
    await tx.stockMovement.create({
      data: {
        product_id: productId,
        delta: -quantity,
        reason,
        ref_type: refType ?? null,
        ref_id: refId ?? null,
        balance_after: updatedProduct.current_stock,
        note: note ?? 'Deduction without batch tracking (legacy stock)',
        staff_id: staffId ?? null,
      },
    })
    return {
      balance_after: updatedProduct.current_stock,
      batches_used: [],
    }
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

async function giveStock(tx, { productId, quantity, batch_id, reason, refType, refId, staffId, note }) {
  if (!productId || !quantity || quantity <= 0) return null

  // Serialize all stock operations on this product
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productId})`

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
    items: (s.items || []).map((it) => ({
      name: it.name,
      quantity: it.quantity,
      unit_price: it.unit_price,
      tax_amount: it.tax_amount,
      price_tier: it.price_tier,
      product_id: it.product_id ?? null,
      category: it.product?.category ?? null,
      unit: it.product?.unit ?? null,
    })),
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

    const linked = prescription.items.filter((it) => it.product_id != null)
    const unlinked = prescription.items.filter((it) => it.product_id == null)
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
    if (prescription.status !== 'pending') {
      return res.status(400).json({ error: `Prescription is already ${prescription.status}` })
    }

    const updated = await prisma.$transaction(async (tx) => {
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

      // ── Validate payments ────────────────────────────────────────────────
      const { hasCredit } = validatePaymentLines(payments, total)

      if (hasCredit && (!customer_phone?.trim() || customer_name === 'Walk-in Customer')) {
        throw Object.assign(new Error('Credit sales require a customer name and phone'), { status: 400 })
      }

      // ── Upsert customer if credit ────────────────────────────────────────
      let customer = null
      if (hasCredit) {
        customer = await tx.pharmacyCustomer.upsert({
          where: { phone: customer_phone.trim() },
          update: {},
          create: {
            name: customer_name.trim(),
            phone: customer_phone.trim(),
          },
        })
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

    await writeAuditLog({
      staffId: currentUser?.id,
      user: currentUser?.username,
      action: 'otc_sale',
      description: `OTC sale ${sale.receipt_number} — ${sale.items.length} line(s), total ${sale.total}`,
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



// ─── GET OTC SALES (update your include) ──────────────────────────────────────

exports.getOtcSales = async (req, res) => {
  try {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0))

    const [sales, totalAgg, todayAgg] = await Promise.all([
      prisma.otcSale.findMany({
        include: {
          items: { include: { product: { select: { category: true, unit: true } } } },
          sold_by_staff: { select: { username: true } },
          payments: true,                          // NEW
          customer: { select: { id: true, name: true, phone: true } }, // NEW
        },
        orderBy: { sold_at: 'desc' },
        take: 100,
      }),
      prisma.otcSale.aggregate({ _sum: { total: true }, _count: true }),
      prisma.otcSale.aggregate({
        where: { sold_at: { gte: todayStart } },
        _sum: { total: true },
        _count: true,
      }),
    ])

    const shaped = sales.map(shapeSale)

    res.json({
      sales: shaped,
      stats: {
        total_sales: totalAgg._count,
        total_revenue: totalAgg._sum.total || 0,
        today_count: todayAgg._count,
        today_revenue: todayAgg._sum.total || 0,
      },
    })
  } catch (err) {
    console.error('getOtcSales', err.message)
    res.status(500).json({ error: 'Failed to fetch OTC sales' })
  }
}

exports.getInternalOrders = async (req, res) => {
  try {
    const { department, status } = req.query

    const where = {}
    if (ORDER_DEPARTMENTS.includes(department)) where.department = department
    if (['pending', 'fulfilled', 'cancelled'].includes(status)) where.status = status

    const [orders, pending, fulfilled, cancelled, total] = await Promise.all([
      prisma.pharmacyOrder.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { requested_at: 'desc' },
        take: 200,
      }),
      prisma.pharmacyOrder.count({ where: { status: 'pending' } }),
      prisma.pharmacyOrder.count({ where: { status: 'fulfilled' } }),
      prisma.pharmacyOrder.count({ where: { status: 'cancelled' } }),
      prisma.pharmacyOrder.count(),
    ])

    res.json({
      orders: orders.map(shapeOrder),
      stats: { pending, fulfilled, cancelled, total },
    })
  } catch (err) {
    console.error('getInternalOrders', err.message)
    res.status(500).json({ error: 'Failed to fetch orders' })
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
    })
    res.json({ customers })
  } catch (err) {
    console.error('getCustomers', err.message)
    res.status(500).json({ error: 'Failed to fetch customers' })
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