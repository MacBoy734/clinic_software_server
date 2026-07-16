const router = require('express').Router()
const c = require('../controllers/expenses_controller')
const { authenticate, authorize } = require('../middleware/auth')

router.get('/', authenticate, authorize('admin', 'receptionist', 'pharmacist'), c.getExpenses)
router.get('/stats', authenticate, authorize('admin', 'receptionist', 'pharmacist'), c.getExpenseStats)
router.post('/', authenticate, authorize('admin', 'receptionist', 'pharmacist'), c.createExpense)
router.put('/:id', authenticate, authorize('admin', 'receptionist', 'pharmacist'), c.updateExpense)
router.delete('/:id', authenticate, authorize('admin'), c.deleteExpense)

module.exports = router