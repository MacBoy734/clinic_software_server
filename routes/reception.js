const router = require('express').Router()
const c = require('../controllers/reception_controller')
const { authenticate, authorize } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../utils/schemaValidations')

// ─── GET routes (light query validation) ─────────────────────────────────────
router.get('/queue', authenticate, authorize('receptionist'), c.getQueue)
router.get('/bills', authenticate, authorize('receptionist'), c.getBills)
router.get('/stats', authenticate, authorize('receptionist'), c.getStats)

router.get('/patients/search', 
  authenticate, 
  authorize('receptionist'), 
  validate({ query: schemas.patientSearchSchema }),   // ← q trimmed, min 2 chars
  c.searchPatients
)

router.get('/charge-templates', authenticate, authorize('receptionist'), c.getChargeTemplates)

// ─── POST register (THE BIG ONE — phone sanitization lives here) ─────────────
router.post('/register', 
  authenticate, 
  authorize('receptionist'), 
  validate({ body: schemas.registerVisitSchema }),    // ← name trimmed, phone regex'd, age coerced, etc.
  c.registerVisit
)




router.patch('/visits/:id/waive',
  authenticate,
  authorize('receptionist'),
  validate({ params: schemas.idParamSchema, body: schemas.waivePaymentSchema }),
  c.waivePayment
)

// NOTE: collectPayment is next — leave it alone for now
router.patch('/payments', authenticate, authorize('receptionist'),  validate({ body: schemas.collectPaymentSchema }), c.collectPayment)

module.exports = router