// server/controllers/pharmacy_controller.js
//
// Endpoints here strictly match what the 4 pharmacy tabs call:
//   InternalOrdersTab → GET /orders, PATCH /orders/:id/fulfill
//   StockTab          → GET /stock, PATCH /stock
//   OTCSalesTab       → GET /drugs, GET /otc-sales, POST /otc-sales
//   QueueTab          → GET /queue, GET /stock, PATCH /prescriptions/:id/dispense,
//                        PATCH /prescriptions/:id/cancel
//
// Settings / markup % management lives in the ADMIN controller, not here.
// getDrugs below only READS the markup setting to compute clinic_price —
// it does not own creating/updating that setting.

const prisma = require('../lib/prisma')
const { getIO } = require('../utils/socket')

async function generateReceiptNumber() {
  const count = await prisma.otcSale.count()
  return `OTC-${String(count + 1).padStart(5, '0')}`
}

// Reads the markup % set by admin. If no settings row exists yet, falls
// back to 25 without creating one — creation/management is the admin
// controller's job, not pharmacy's.
async function readMarkupPct() {
  const settings = await prisma.clinicSettings.findUnique({ where: { id: 1 } })
  return settings?.prescription_markup_pct ?? 25
}

// Same heuristic the frontend uses client-side to match a prescribed drug
// name against a stock row.
function matchStockItem(drugName, stock) {
  if (!drugName || !stock?.length) return null
  const firstWord = drugName.toLowerCase().split(' ')[0]
  return (
    stock.find(
      (s) =>
        s.name.toLowerCase().includes(firstWord) ||
        s.generic_name.toLowerCase().includes(firstWord)
    ) || null
  )
}

// Shape a Prescription + items into what QueueTab / DispenseModal expect
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
      dosage: it.dosage,
      frequency: it.frequency,
      duration: it.duration,
      quantity: it.quantity,
      unit_cost: it.unit_cost,
      status: it.status,
      decline_reason: it.decline_reason ?? null,
      dispensed_at: it.dispensed_at ?? null,
    })),
  }
}

const PRESCRIPTION_INCLUDE = {
  items: true,
  visit: {
    include: {
      patient: { select: { name: true, age: true, gender: true } },
    },
  },
}

// ─── Stock (StockTab) ─────────────────────────────────────────────────────────

// GET /api/pharmacy/stock
exports.getStock = async (req, res) => {
  try {
    const items = await prisma.drugStock.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
    // StockTab's table reads item.unit_price — alias it from normal_price
    const shaped = items.map((i) => ({ ...i, unit_price: i.normal_price }))
    res.json({ items: shaped })
  } catch (err) {
    console.error('getStock', err)
    res.status(500).json({ error: 'Failed to fetch stock' })
  }
}

// PATCH /api/pharmacy/stock   body: { id, quantity, batch_number }
// "quantity" is the amount being ADDED — matches RestockModal's "+N units".
exports.restockDrug = async (req, res) => {
  try {
    const { id, quantity, batch_number } = req.body
    if (!id || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'id and a positive quantity are required' })
    }

    const updated = await prisma.drugStock.update({
      where: { id: parseInt(id) },
      data: {
        current_stock: { increment: parseInt(quantity) },
        ...(batch_number ? { batch_number } : {}),
      },
    })

    res.json({ success: true, item: { ...updated, unit_price: updated.normal_price } })
  } catch (err) {
    console.error('restockDrug', err)
    res.status(500).json({ error: 'Failed to restock item' })
  }
}

// ─── Drugs (OTCSalesTab's search dropdown) ───────────────────────────────────

// GET /api/pharmacy/drugs
exports.getDrugs = async (req, res) => {
  try {
    const [items, markupPct] = await Promise.all([
      prisma.drugStock.findMany({ orderBy: { name: 'asc' } }),
      readMarkupPct(),
    ])

    const shaped = items.map((d) => ({
      ...d,
      pharmacy_normal_price: d.normal_price,
      promotional_price: d.promotional_price,
      wholesale_price: d.wholesale_price,
      // Read-only here — clinic_price is informational only on this
      // endpoint, computed from whatever admin has set elsewhere.
      clinic_price: Math.round(d.normal_price * (1 + markupPct / 100)),
    }))

    res.json({ items: shaped })
  } catch (err) {
    console.error('getDrugs', err)
    res.status(500).json({ error: 'Failed to fetch drugs' })
  }
}

// ─── Queue (QueueTab) ─────────────────────────────────────────────────────────

// GET /api/pharmacy/queue
exports.getQueue = async (req, res) => {
  try {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0))

    const [pending, dispensedToday] = await Promise.all([
      prisma.prescription.findMany({
        where: { status: 'pending' },
        include: PRESCRIPTION_INCLUDE,
        orderBy: { created_at: 'asc' },
      }),
      prisma.prescription.count({
        where: {
          status: { in: ['dispensed', 'issued'] },
          dispensed_at: { gte: todayStart },
        },
      }),
    ])

    res.json({
      prescriptions: pending.map(shapePrescription),
      dispensed_today: dispensedToday,
    })
  } catch (err) {
    console.error('getQueue', err)
    res.status(500).json({ error: 'Failed to fetch queue' })
  }
}

// PATCH /api/pharmacy/prescriptions/:id/dispense   body: { pharmacist_id }
//
// Side-effects:
//   → decrement DrugStock.current_stock for each matched item
//   → Prescription.status = 'dispensed', dispensed_at = now
//   → every PrescriptionItem.status = 'issued'
//   → Visit.status = 'billing', Visit.medication_verification = true
exports.dispensePrescription = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { pharmacist_id } = req.body

    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: PRESCRIPTION_INCLUDE,
    })
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' })
    if (prescription.status !== 'pending') {
      return res.status(400).json({ error: `Prescription is already ${prescription.status}` })
    }

    const stock = await prisma.drugStock.findMany()

    await Promise.all(
      prescription.items.map(async (item) => {
        const match = matchStockItem(item.drug_name, stock)
        if (match) {
          await prisma.drugStock.update({
            where: { id: match.id },
            data: { current_stock: { decrement: Math.min(item.quantity, match.current_stock) } },
          })
        }
        return prisma.prescriptionItem.update({
          where: { id: item.id },
          data: { status: 'issued', dispensed_at: new Date() },
        })
      })
    )

    const updated = await prisma.prescription.update({
      where: { id },
      data: {
        status: 'dispensed',
        dispensed_at: new Date(),
        pharmacist_id: pharmacist_id ? parseInt(pharmacist_id) : undefined,
      },
      include: PRESCRIPTION_INCLUDE,
    })

    await prisma.visit.update({
      where: { id: prescription.visit_id },
      data: { status: 'billing', medication_verification: true },
    })

    try {
      getIO().emit('rx:dispensed', {
        visitId: prescription.visit_id,
        patientName: prescription.visit?.patient?.name,
      })
      getIO().emit('visit:status_changed', { visitId: prescription.visit_id })
    } catch (socketErr) {
      console.error('Socket emit failed:', socketErr)
    }

    res.json({ success: true, prescription: shapePrescription(updated) })
  } catch (err) {
    console.error('dispensePrescription', err)
    res.status(500).json({ error: 'Failed to dispense prescription' })
  }
}

// PATCH /api/pharmacy/prescriptions/:id/cancel   body: { reason, cancelled_by }
//
// Used when the patient declines treatment at the pharmacy counter.
// Status → 'cancelled' (not 'returned' — that's for doctor corrections).
exports.cancelPrescription = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { reason, cancelled_by } = req.body

    const prescription = await prisma.prescription.findUnique({ where: { id } })
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' })
    if (prescription.status !== 'pending') {
      return res.status(400).json({ error: `Prescription is already ${prescription.status}` })
    }

    const updated = await prisma.prescription.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelled_by: cancelled_by ?? null,
        cancelled_at: new Date(),
        cancel_reason: reason ?? null,
      },
      include: PRESCRIPTION_INCLUDE,
    })

    await prisma.visit.update({
      where: { id: prescription.visit_id },
      data: { status: 'billing' },
    })

    try {
      getIO().emit('visit:status_changed', { visitId: prescription.visit_id })
    } catch (socketErr) {
      console.error('Socket emit failed:', socketErr)
    }

    res.json({ success: true, prescription: shapePrescription(updated) })
  } catch (err) {
    console.error('cancelPrescription', err)
    res.status(500).json({ error: 'Failed to cancel prescription' })
  }
}

// ─── OTC Sales (OTCSalesTab) ──────────────────────────────────────────────────

// GET /api/pharmacy/otc-sales
exports.getOtcSales = async (req, res) => {
  try {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0))

    const [sales, totalAgg, todayAgg] = await Promise.all([
      prisma.otcSale.findMany({
        include: { items: true, sold_by_staff: { select: { username: true } } },
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

    const shaped = sales.map((s) => ({
      id: s.id,
      receipt_number: s.receipt_number,
      customer_name: s.customer_name,
      payment_method: s.payment_method,
      sold_by: s.sold_by_staff?.username ?? 'Pharmacist',
      sold_at: s.sold_at,
      total: s.total,
      items: s.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unit_price: it.unit_price,
        price_tier: it.price_tier,
      })),
    }))

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
    console.error('getOtcSales', err)
    res.status(500).json({ error: 'Failed to fetch OTC sales' })
  }
}

// POST /api/pharmacy/otc-sales
// body: { customer_name, payment_method, sold_by, items: [{drug_id, name, quantity, unit_price, price_tier}] }
exports.createOtcSale = async (req, res) => {
  try {
    const { customer_name, payment_method, sold_by, items } = req.body

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' })
    }

    const total = items.reduce((s, i) => s + (i.unit_price || 0) * (i.quantity || 0), 0)
    const receiptNumber = await generateReceiptNumber()

    let soldByStaff = null
    if (sold_by) {
      soldByStaff = await prisma.staff.findFirst({ where: { username: sold_by } })
    }

    const sale = await prisma.$transaction(async (tx) => {
      const created = await tx.otcSale.create({
        data: {
          receipt_number: receiptNumber,
          customer_name: customer_name || 'Walk-in Customer',
          payment_method: payment_method || 'cash',
          sold_by_id: soldByStaff?.id ?? null,
          total,
          items: {
            create: items.map((i) => ({
              drug_id: i.drug_id ? parseInt(i.drug_id) : null,
              name: i.name,
              quantity: parseInt(i.quantity) || 1,
              unit_price: parseInt(i.unit_price) || 0,
              price_tier: i.price_tier || 'normal',
            })),
          },
        },
        include: { items: true },
      })

      for (const item of items) {
        if (item.drug_id) {
          await tx.drugStock.update({
            where: { id: parseInt(item.drug_id) },
            data: { current_stock: { decrement: parseInt(item.quantity) || 1 } },
          })
        }
      }

      return created
    })

    res.json({
      success: true,
      sale: {
        id: sale.id,
        receipt_number: sale.receipt_number,
        customer_name: sale.customer_name,
        payment_method: sale.payment_method,
        sold_by: sold_by || 'Pharmacist',
        sold_at: sale.sold_at,
        total: sale.total,
        items: sale.items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit_price: it.unit_price,
          price_tier: it.price_tier,
        })),
      },
    })
  } catch (err) {
    console.error('createOtcSale', err)
    res.status(500).json({ error: 'Failed to create OTC sale' })
  }
}

// ─── Internal supply orders (InternalOrdersTab) ──────────────────────────────

// GET /api/pharmacy/orders
exports.getInternalOrders = async (req, res) => {
  try {
    const [orders, pending, fulfilled, cancelled, total] = await Promise.all([
      prisma.pharmacyOrder.findMany({
        include: { items: true },
        orderBy: { requested_at: 'desc' },
      }),
      prisma.pharmacyOrder.count({ where: { status: 'pending' } }),
      prisma.pharmacyOrder.count({ where: { status: 'fulfilled' } }),
      prisma.pharmacyOrder.count({ where: { status: 'cancelled' } }),
      prisma.pharmacyOrder.count(),
    ])

    res.json({ orders, stats: { pending, fulfilled, cancelled, total } })
  } catch (err) {
    console.error('getInternalOrders', err)
    res.status(500).json({ error: 'Failed to fetch orders' })
  }
}

// PATCH /api/pharmacy/orders/:id/fulfill   body: { fulfilled_by }
exports.fulfillOrder = async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { fulfilled_by } = req.body

    const order = await prisma.pharmacyOrder.findUnique({ where: { id } })
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order is already ${order.status}` })
    }

    const updated = await prisma.pharmacyOrder.update({
      where: { id },
      data: {
        status: 'fulfilled',
        fulfilled_by: fulfilled_by ?? null,
        fulfilled_at: new Date(),
      },
      include: { items: true },
    })

    try {
      getIO().emit('notification:new', {
        message: `Supply order #${id} fulfilled for ${order.requested_by}`,
      })
    } catch (socketErr) {
      console.error('Socket emit failed:', socketErr)
    }

    res.json({ success: true, order: updated })
  } catch (err) {
    console.error('fulfillOrder', err)
    res.status(500).json({ error: 'Failed to fulfil order' })
  }
}