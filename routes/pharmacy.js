const express = require('express')
const router = express.Router()
const { authenticate, authorize } = require('../middleware/auth')
const c = require('../controllers/pharmacy_controller')

// Everything below needs a session.
router.use(authenticate)

const PHARMACY = authorize('pharmacist', 'admin')
// Roles that raise supply orders and need to browse the catalogue.
const REQUESTERS = authorize('pharmacist', 'admin', 'doctor', 'lab_tech',)

// ─── Catalogue ────────────────────────────────────────────────────────────────

router.get('/products', REQUESTERS, c.getProducts)
router.get('/customers', PHARMACY, c.getCustomers)
router.get('/categories', REQUESTERS, c.getCategories)
router.get('/products/:id/movements', PHARMACY, c.getProductMovements)

// Deprecated: /drugs is pinned to category=medication so old clients work.
router.get('/drugs', REQUESTERS, c.getDrugs)

// ─── Stock table ──────────────────────────────────────────────────────────────
// No category parameter → every category. This is the one screen that sees
// the whole catalogue.

router.get('/stock', PHARMACY, c.getStock)

// ─── Restock requests ─────────────────────────────────────────────────────────
// Pharmacy raises, admin approves. Nothing here touches current_stock.

router.get('/restock-requests', PHARMACY, c.getRestockRequests)
router.post('/restock-requests', PHARMACY, c.createRestockRequest)

// ─── Prescription queue ───────────────────────────────────────────────────────

router.get('/queue', PHARMACY, c.getQueue)
router.patch('/prescriptions/:id/dispense', PHARMACY, c.dispensePrescription)
router.patch('/prescriptions/:id/cancel', PHARMACY, c.cancelPrescription)

// ─── OTC sales ────────────────────────────────────────────────────────────────

router.get('/otc-sales', PHARMACY, c.getOtcSales)
router.post('/otc-sales', PHARMACY, c.createOtcSale)

// ─── Internal supply orders ───────────────────────────────────────────────────
// POST is open to every requesting department; the order's department is
// derived from the caller's ROLE inside the controller, never from the body.
// Fulfilment and cancellation stay with the pharmacy.

router.get('/orders', REQUESTERS, c.getInternalOrders)
router.post('/orders', REQUESTERS, c.createInternalOrder)
router.patch('/orders/:id/fulfill', PHARMACY, c.fulfillOrder)
router.patch('/orders/:id/cancel', PHARMACY, c.cancelOrder)

module.exports = router