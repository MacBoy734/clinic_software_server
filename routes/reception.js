const router = require('express').Router()
const c = require('../controllers/reception_controller')
const { authenticate, authorize } = require('../middleware/auth')

router.get('/queue', authenticate, authorize('receptionist'), c.getQueue)
router.get('/visits', authenticate, authorize('receptionist'), c.getVisits)
router.get('/bills', authenticate, authorize('receptionist'), c.getBills)
router.get('/stats', authenticate, authorize('receptionist'), c.getStats)
router.get('/patients/search', authenticate, authorize('receptionist'), c.searchPatients)
router.get('/charge-templates', authenticate, authorize('receptionist'), c.getChargeTemplates)
router.post('/register', authenticate, authorize('receptionist'), c.registerVisit)

router.patch('/visits/:id/forward-to-doctor', authenticate, authorize('receptionist'), c.forwardToDoctor)
router.patch('/visits/:id/forward-to-lab', authenticate, authorize('receptionist'), c.forwardToLab)
router.patch('/visits/:id/forward-to-billing', authenticate, authorize('receptionist'), c.forwardToBilling)
router.patch('/visits/:id/mark-done', authenticate, authorize('receptionist'), c.markDone)
router.patch('/visits/:id/archive', authenticate, authorize('receptionist'), c.archiveVisit)
router.patch('/visits/:id/stage1-payment', authenticate, authorize('receptionist'), c.stage1Payment)
router.patch('/visits/:id/waive-stage1', c.waiveStage1)
router.patch('/payments', authenticate, authorize('receptionist'), c.collectPayment)

module.exports = router