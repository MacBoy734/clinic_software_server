// server/routes/doctorRoutes.js
//
// Mount in server/app.js:
//   const doctorRoutes = require('./routes/doctorRoutes')
//   app.use('/api/doctor', doctorRoutes)
//
// NAMING: the previous router required '../controllers/consultation_controller'
// while the file on disk was doctorController.js, and the frontend calls
// /api/doctor/*. Everything is now doctor/doctor/doctor. If you would rather
// standardise on "consultation", rename all three together — router file,
// controller file, and the api.get() paths in the tabs — not one of them.
//
// WHAT WAS BROKEN BEFORE
//   • PATCH /prescriptions/:id/return-item was registered TWICE. The second
//     registration pointed at returnPrescription, which Express never
//     reached because the first handler already matched. returnPrescription
//     was dead code (and would have thrown ReferenceError if it had run).
//     It now has its own path: PATCH /prescriptions/:id/return.
//   • confirmRestock existed in the controller but was on no route.
//   • 'complete-procudure' was a typo. The correct spelling is mounted; the
//     misspelling stays as an alias so an un-updated client keeps working.
//     Delete the alias once the consultation page is redeployed.
//   • POST /orders was missing, so the doctor's supply-order form had
//     nowhere to submit.

const router = require('express').Router()
const c = require('../controllers/consultation_controller')
const { authenticate, authorize } = require('../middleware/auth')

router.use(authenticate, authorize('doctor'))

// ─── Queue and visits ─────────────────────────────────────────────────────────

router.get('/queue', c.getQueue)
router.get('/visits/:id', c.getVisit)
router.get('/patients', c.getPatientDatabase)

// ─── Catalogues ───────────────────────────────────────────────────────────────

router.get('/lab-catalog', c.getLabCatalog)
router.get('/procedures', c.getProcedures)

// Prescription picker: category = medication, in stock.
router.get('/drugs', c.getDrugs)

// Read-only medications overview (ExpiringMedsTab). category = medication,
// so the expiry list is not diluted by consumables that never expire.
router.get('/drug-stock', c.getDrugStock)

// Supply-order picker: everything that is NOT a medication — gloves,
// syringes, scalpel blades, soap.
router.get('/supplies', c.getSupplies)

// ─── Internal supply orders ───────────────────────────────────────────────────
// POST delegates to the pharmacy controller's single implementation, which
// derives the department from the caller's role and rejects medications.

router.get('/orders', c.getDoctorOrders)
router.post('/orders', c.createPharmacyOrder)

// ─── Per-visit clinical work ──────────────────────────────────────────────────

router.get('/visits/:id/labs', c.getLabRequests)
router.post('/visits/:id/labs', c.orderLabTests)

router.get('/visits/:id/prescriptions', c.getPrescriptions)
router.post('/visits/:id/prescriptions', c.createPrescription)

router.patch('/visits/:id', c.patchVisit)
router.patch('/visits/:id/complete-procedure', c.completeProcedure)
// Deprecated spelling — remove once the consultation page is redeployed.
router.patch('/visits/:id/complete-procudure', c.completeProcedure)

// ─── Prescription review ──────────────────────────────────────────────────────

router.patch('/prescriptions/:id/verify', c.verifyPrescription)
router.patch('/prescriptions/:id/return-item', c.returnPrescriptionItem)
router.patch('/prescriptions/:id/return', c.returnPrescription)
router.patch('/prescription-items/:id/confirm-restock', c.confirmRestock)

module.exports = router