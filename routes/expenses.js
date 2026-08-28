const router = require('express').Router()
const c = require('../controllers/expenses_controller')
const { authenticate, authorize } = require('../middleware/auth')
const validate = require('../middleware/validate')
const schemas = require('../utils/schemaValidations')

router.get('/', 
  authenticate, 
  authorize('admin', 'receptionist', 'pharmacist'), 
  validate({ query: schemas.getExpensesQuerySchema }), 
  c.getExpenses
)

router.get('/stats', 
  authenticate, 
  authorize('admin', 'receptionist', 'pharmacist'), 
  validate({ query: schemas.getExpenseStatsQuerySchema }), 
  c.getExpenseStats
)

router.post('/', 
  authenticate, 
  authorize('admin', 'receptionist', 'pharmacist'), 
  validate({ body: schemas.createExpenseSchema }), 
  c.createExpense
)

router.put('/:id', 
  authenticate, 
  authorize('admin'), 
  validate({ params: schemas.idParamSchema, body: schemas.updateExpenseSchema }), 
  c.updateExpense
)

router.delete('/:id', 
  authenticate, 
  authorize('admin'), 
  validate({ params: schemas.idParamSchema }), 
  c.deleteExpense
)

module.exports = router