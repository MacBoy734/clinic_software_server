// server/routes/pharmacyRoutes.js
//
// Only the 8 endpoints the 4 pharmacy tabs actually call. Order/markup
// settings management lives on the admin router, not here.

const express = require('express')
const router = express.Router()
const { authorize, authenticate } = require('../middleware/auth')
const c = require('../controllers/pharmacy_controller')

router.get('/drugs',authenticate, authorize('pharmacist', 'admin', 'doctor'), c.getDrugs)

router.use(authenticate, authorize('pharmacist', 'admin'))

// ─── Stock (StockTab) ─────────────────────────────────────────────────────────
router.get('/stock', c.getStock)
router.patch('/stock', c.restockDrug)


// ─── Queue (QueueTab) ─────────────────────────────────────────────────────────
router.get('/queue', c.getQueue)
router.patch('/prescriptions/:id/dispense', c.dispensePrescription)
router.patch('/prescriptions/:id/cancel', c.cancelPrescription)

// ─── OTC Sales (OTCSalesTab) ──────────────────────────────────────────────────
router.get('/otc-sales', c.getOtcSales)
router.post('/otc-sales', c.createOtcSale)

// ─── Internal supply orders (InternalOrdersTab) ──────────────────────────────
router.get('/orders', c.getInternalOrders)
router.patch('/orders/:id/fulfill', c.fulfillOrder)

module.exports = router


// ─── Mount in server/app.js ───────────────────────────────────────────────────
//
//   const pharmacyRoutes = require('./routes/pharmacyRoutes')
//   app.use('/api/pharmacy', pharmacyRoutes)
//
// NOTE: doctor and lab's "create supply order" POST (department: 'doctor'|'lab')
// is NOT included here since it wasn't in any of the 4 pharmacy files sent.
// Wherever you build that endpoint, it just needs to write to the same
// PharmacyOrder model this router reads from.