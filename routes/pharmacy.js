const express = require('express')
const router = express.Router()
const { authenticate, authorize } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../utils/schemaValidations')
const c = require('../controllers/pharmacy_controller')

// Everything below needs a session.
router.use(authenticate)

const PHARMACY = authorize('pharmacist', 'admin')
// Roles that raise supply orders and need to browse the catalogue.
const REQUESTERS = authorize('pharmacist', 'admin', 'doctor', 'lab_tech')

// ─── Catalogue ────────────────────────────────────────────────────────────────

router.get('/products', REQUESTERS, c.getProducts)
router.get('/customers', PHARMACY, c.getCustomers)
router.get('/categories', REQUESTERS, c.getCategories)
router.get('/products/:id/movements', PHARMACY, validate({ params: schemas.idParamSchema }), c.getProductMovements)

// Deprecated: /drugs is pinned to category=medication so old clients work.
router.get('/drugs', REQUESTERS, c.getDrugs)

// ─── Stock table ──────────────────────────────────────────────────────────────

router.get('/stock', PHARMACY, c.getStock)

// ─── Restock requests ─────────────────────────────────────────────────────────

router.get('/restock-requests', PHARMACY, c.getRestockRequests)
router.post('/restock-requests', PHARMACY, validate({ body: schemas.createRestockRequestSchema }), c.createRestockRequest)

// ─── Prescription queue ───────────────────────────────────────────────────────

router.get('/queue', PHARMACY, c.getQueue)
router.patch('/prescriptions/:id/dispense', PHARMACY, validate({ params: schemas.idParamSchema }), c.dispensePrescription)
router.patch('/prescriptions/:id/cancel', PHARMACY, validate({ params: schemas.idParamSchema }), c.cancelPrescription)

router.patch('/prescription-items/:id/confirm-restock', 
  PHARMACY, 
  validate({ params: schemas.idParamSchema }), 
  c.confirmRestock
)


// ─── OTC sales ────────────────────────────────────────────────────────────────

router.get('/otc-sales', PHARMACY, c.getOtcSales)
router.post('/otc-sales', PHARMACY, validate({ body: schemas.createOtcSaleSchema }), c.createOtcSale)

// ─── Internal supply orders ───────────────────────────────────────────────────

router.get('/orders', REQUESTERS, c.getInternalOrders)
router.post('/orders', REQUESTERS, validate({ body: schemas.createInternalOrderSchema }), c.createInternalOrder)
router.patch('/orders/:id/fulfill', PHARMACY, validate({ params: schemas.idParamSchema, body: schemas.fulfillOrderSchema }), c.fulfillOrder)
router.patch('/orders/:id/cancel', PHARMACY, validate({ params: schemas.idParamSchema, body: schemas.cancelOrderSchema }), c.cancelOrder)

module.exports = router