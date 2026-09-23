const express = require('express')
const c = require('../controllers/admin_controller')
const p = require('../controllers/pharmacy_controller')
const router = express.Router()
const { authenticate, authorize } = require('../middleware/auth')
const schemas = require('../utils/schemaValidations')
const validate = require('../middleware/validate') 

// allow other users to access settings
router.get('/settings', authenticate, c.getSettings)


// All routes in this router require authentication and admin authorization
router.use(authenticate, authorize('admin'))

// GET routes
router.get('/staff', c.getAllStaff)
router.get('/internal-orders', p.getInternalOrders)
router.get('/lab-requests', c.getLabRequests)
router.get('/restocks', c.getRestocks)
router.get('/overview', c.getAdminOverview)
router.get('/finance-overview', c.getFinanceOverview)
router.get('/outstanding-balances', c.getOutstandingBalances)
router.get('/lab-stats', c.getLabStats)
router.get('/charge-templates', c.getChargeTemplates)
router.get('/reports/visits', c.getAdminVisitsReport)
router.get('/reports/lab', c.getLabReport)
router.get('/reports/pharmacy', c.getPharmacyReport)
router.get('/referrals', c.getReferrals)
router.get('/lab-stock', c.getLabStock)
router.get('/drug-stock', c.getPharmacyStock)
router.get('/lab-techs', c.getLabTechs)
router.get('/logs', c.getLogs)
router.get('/logs/stats', c.getLogStats)
router.get('/sessions', c.getSessions)
router.get('/patients', c.getPatients)
router.get('/patients/stats',  c.getPatientStats)
router.get('/patients/insights', c.getPatientInsights)
router.get('/patients/:id',    c.getPatientDetail)
router.get('/bills',    c.getBills)
router.get('/bills/queue', c.getBillingQueueToday)
router.get('/payments', c.getPayments)
router.get('/revenue/week', c.getRevenueWeek)
router.get('/finance/revenue', c.getRevenueReport)
router.get('/products/:id', validate({ params: schemas.idParamSchema }), c.getProductDetail)
router.get('/products/:id/movements', validate({ params: schemas.idParamSchema }), c.getProductMovements)

// ── Pharmacy finance ──────────────────────────────────────────────────────────
router.get('/pharmacy/finance-overview', c.getPharmacyFinanceOverview)
router.get('/pharmacy/sales', c.getPharmacySales)
router.get('/pharmacy/debt-book', c.getDebtBook)
router.post('/pharmacy/customer-payments', c.collectCustomerPayment)

// POST routes
router.post('/referrals', c.createReferral)
router.post('/charge-templates', c.createChargeTemplate)
router.post('/drug-stock', c.createStockItem)
router.post('/staff', c.addStaffPost)
router.post('/lab-stock', c.createLabStockItem)
router.post('/stocktake/:id/approve',  c.approveStocktake)
router.post('/stocktake/:id/reject',  c.rejectStocktake)

// PATCH routes
router.patch('/referrals/:id/pay', c.payReferral)
router.patch('/restocks/:id/verify', c.verifyRestock)
router.patch('/restocks/:id/reject', c.rejectRestock)
router.patch('/outstanding-balances/:visitId',  c.updateOutstandingBalance)
router.patch('/charge-templates/:id', c.updateChargeTemplate)
router.get('/lab-catalog', c.getLabCatalog)
router.patch('/lab-catalog/:id', c.updateLabCatalogItem)
router.patch('/lab-stock/:id/quantity', c.updateLabStockQuantity)
router.patch('/staff/:id', c.toggleStaffStatus)
router.patch('/settings', c.patchSettings)
router.patch('/staff/:id/password', c.resetStaffPassword)

// PUT routes
router.put('/drug-stock/:id', c.updateDrugStockItem)
router.put('/drug-stock/:id/quantity', c.updateStockItemQuantity)
router.put('/lab-stock/:id', c.updateLabStockItem)

// DELETE routes
router.delete('/drug-stock/:id', validate({ params: schemas.idParamSchema }), c.deletePharmacyStockItem)
router.delete('/charge-templates/:id', c.deleteChargeTemplate)
router.delete('/sessions/:id', c.deleteSession)
router.delete('/lab-stock/:id', c.deleteLabStockItem)





module.exports = router