const router = require('express').Router()
const c = require('../controllers/consultation_controller')
const { authenticate, authorize } = require('../middleware/auth')

router.get('/queue', authenticate, authorize('doctor'), c.getQueue)
router.get('/visits/:id', authenticate, authorize('doctor'), c.getVisit)
router.get('/patients', authenticate, authorize('doctor'), c.getPatientDatabase)
router.get('/lab-catalog', authenticate, authorize('doctor'), c.getLabCatalog)
router.get('/orders', authenticate, authorize('doctor'), c.getDoctorOrders)
router.get('/procedures', authenticate, authorize('doctor'), c.getProcedures)
router.get('/visits/:id/prescriptions', authenticate, authorize('doctor'), c.getPrescriptions)
router.get('/visits/:id/labs', authenticate, authorize('doctor'), c.getLabRequests)

router.post('/visits/:id/labs', authenticate, authorize('doctor'), c.orderLabTests)
router.post('/visits/:id/prescriptions', authenticate, authorize('doctor'), c.createPrescription)

router.patch('/visits/:id', authenticate, authorize('doctor'), c.patchVisit)
router.patch('/visits/:id/complete-procudure', authenticate, authorize('doctor'), c.completeProcedure)
router.patch('/prescriptions/:id/return-item', authenticate, authorize('doctor'), c.returnPrescriptionItem)
router.patch('/prescriptions/:id/verify', authenticate, authorize('doctor'), c.verifyPrescription)
router.patch('/prescriptions/:id/return-item', authenticate, authorize('doctor'), c.returnPrescription)

module.exports = router