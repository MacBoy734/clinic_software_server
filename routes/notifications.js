const express = require('express')
const router  = express.Router()

const { getNotifications, createNotification, deleteNotification, deleteOldNotifications, markAllRead } = require('../controllers/notifications_controller')

const { authenticate, authorize } = require('../middleware/auth')

router.get('/', authenticate, getNotifications)
router.post('/', authenticate, authorize('admin'), createNotification)
router.patch('/read-all', authenticate, markAllRead)
router.delete('/old', authenticate, authorize('admin'), deleteOldNotifications)
router.delete('/:id', authenticate, authorize('admin'), deleteNotification)

module.exports = router