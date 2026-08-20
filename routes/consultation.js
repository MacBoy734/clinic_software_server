// server/routes/doctorRoutes.js
const router = require('express').Router()
const validate = require('../middleware/validate')   // your existing file
const c = require('../controllers/consultation_controller')
const { authenticate, authorize } = require('../middleware/auth')
const schemas = require('../utils/schemaValidations')

router.use(authenticate, authorize('doctor'))

// ─── Queue and visits ─────────────────────────────────────────────────────────

router.get('/queue', c.getQueue)
router.get('/visits/:id', validate({ params: schemas.idParamSchema }), c.getVisit)
router.get('/patients', validate({ query: schemas.patientDatabaseQuerySchema }), c.getPatientDatabase)

// ─── Catalogues ───────────────────────────────────────────────────────────────

router.get('/lab-catalog', c.getLabCatalog)
router.get('/drugs', c.getDrugs)
router.get('/drug-stock', c.getDrugStock)
router.get('/supplies', validate({ query: schemas.suppliesQuerySchema }), c.getSupplies)

// ─── Internal supply orders ───────────────────────────────────────────────────

router.get('/orders', c.getDoctorOrders)
router.post('/orders', validate({ body: schemas.createInternalOrderSchema }), c.createPharmacyOrder)

// ─── Per-visit clinical work ──────────────────────────────────────────────────

router.get('/visits/:id/labs', validate({ params: schemas.idParamSchema }), c.getLabRequests)
router.post('/visits/:id/labs',
  validate({ params: schemas.idParamSchema, body: schemas.orderLabTestsSchema }),
  c.orderLabTests
)

router.get('/visits/:id/prescriptions', validate({ params: schemas.idParamSchema }), c.getPrescriptions)
router.post('/visits/:id/prescriptions',
  validate({ params: schemas.idParamSchema, body: schemas.createPrescriptionSchema }),
  c.createPrescription
)

router.patch('/visits/:id',
  validate({ params: schemas.idParamSchema, body: schemas.patchVisitSchema }),
  c.patchVisit
)

router.patch('/visits/:id/complete-procedure', validate({ params: schemas.idParamSchema, body: schemas.completeProcedureSchema }), c.completeProcedure)

// ─── Prescription review ──────────────────────────────────────────────────────

router.patch('/prescriptions/:id/return-item',
  validate({ params: schemas.idParamSchema, body: schemas.returnItemSchema }),
  c.returnPrescriptionItem
)
router.patch('/prescriptions/:id/return',
  validate({ params: schemas.idParamSchema, body: schemas.returnPrescriptionSchema }),
  c.returnPrescription
)

module.exports = router