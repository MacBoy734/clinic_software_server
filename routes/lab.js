// server/routes/labRoutes.js
const express = require('express')
const router = express.Router()
const { authorize, authenticate } = require('../middleware/auth')
const c = require('../controllers/lab_controller')


router.get('/catalog', authenticate, authorize('receptionist', 'doctor', 'admin'), c.getLabTestCatalog)

// All lab routes require authentication
router.use(authenticate, authorize('lab_tech', 'admin'))

router.get('/stats', c.getStats)
router.get('/queue', c.getQueue)
router.get('/requests', c.getRequests)
router.get('/requests/:id', c.getRequestById)
router.get('/stock', c.getStock)
router.get('/orders', c.getLabOrders)
router.get('/supplies', c.getSupplies)
router.post('/orders', c.createPharmacyOrder)
router.patch('/requests/:id/status', c.updateRequestStatus)

module.exports = router
