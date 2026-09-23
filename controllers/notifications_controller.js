const prisma = require('../lib/prisma')

const PAGE_SIZE = 20

function buildVisibilityWhere(staffId, role) {
  return {
    OR: [
      // True broadcast — no targeting at all
      // Json? fields require { equals: null } not bare null
      {
        staff_id: null,
        target_staff_id: null,
        target_role: { equals: null },
      },

      // Role-targeted broadcast
      {
        staff_id: null,
        target_staff_id: null,
        target_role: { array_contains: role },
      },

      // Directly targeted at this staff member
      { target_staff_id: staffId },

      // Legacy direct staff_id assignment
      { staff_id: staffId },
    ],
  }
}

function last24hrsFilter() {
  const since = new Date()
  since.setHours(since.getHours() - 24)
  return { gte: since }
}

// Shape a raw Prisma notification row into the API response object
function shapeNotification(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    visit_id: n.visit_id ?? null,
    timestamp: n.timestamp,
    is_read: n.is_read,
  }
}

module.exports.getNotifications = async (req, res) => {
  const staffId = req.user.id
  const role = req.user.role

  const page = Math.max(1, Number(req.query.page) || 1)
  const perPage = Math.min(50, Math.max(1, Number(req.query.per_page) || PAGE_SIZE))
  const hours = req.query.hours !== undefined ? Number(req.query.hours) : 24
  const skip = (page - 1) * perPage

  const visibilityWhere = buildVisibilityWhere(staffId, role)

  const timeWhere = hours > 0
    ? (() => {
      const since = new Date()
      since.setHours(since.getHours() - hours)
      return { timestamp: { gte: since } }
    })()
    : {}

  const where = {
    AND: [
      visibilityWhere,
      timeWhere,
    ],
  }

  try {
    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip,
        take: perPage,
      }),

      prisma.notification.count({ where }),

      // Unread = visible to this user, last 24h, not yet read by anyone
      prisma.notification.count({
        where: {
          AND: [
            visibilityWhere,
            { timestamp: last24hrsFilter() },
            { is_read: false },
          ],
        },
      }),
    ])

    const totalPages = Math.ceil(total / perPage)

    return res.json({
      notifications: notifications.map(shapeNotification),
      unread_count: unreadCount,
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: totalPages,
        has_more: page < totalPages,
      },
    })
  } catch (err) {
    console.error('getNotifications error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch notifications' })
  }
}

// ─── PATCH /api/notifications/read-all ────────────────────────────────────────
// Marks every notification visible to the caller as read. Because is_read is
// on the shared row, this also clears the badge for everyone else who can see
// the same notifications (e.g. all doctors) — intended behavior.
module.exports.markAllRead = async (req, res) => {
  const staffId = req.user.id
  const role = req.user.role

  try {
    const { count } = await prisma.notification.updateMany({
      where: {
        AND: [
          buildVisibilityWhere(staffId, role),
          { is_read: false },
        ],
      },
      data: { is_read: true },
    })
    return res.json({ success: true, marked: count })
  } catch (err) {
    console.error('markAllRead error:', err.message)
    return res.status(500).json({ error: 'Failed to mark notifications as read' })
  }
}

// ─── POST /api/notifications ──────────────────────────────────────────────────
// Admin only — create a notification manually.
// Other controllers use createNotificationInternal() directly.
//
// Body:
//   type            String   required
//   title           String   required
//   message         String   required
//   visit_id        Int?
//   target_role     String[] e.g. ["doctor"] or ["lab_tech","receptionist"]
//   target_staff_id Int?
//   staff_id        Int?
module.exports.createNotification = async (req, res) => {
  const { type, title, message, visit_id, target_role, target_staff_id, staff_id } = req.body

  if (!type?.trim()) return res.status(400).json({ error: 'type is required' })
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' })
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' })

  try {
    const notification = await prisma.notification.create({
      data: {
        type, title, message,
        visit_id: visit_id ?? null,
        target_staff_id: target_staff_id ?? null,
        staff_id: staff_id ?? null,
        ...(target_role != null && { target_role }),
      },
    })
    return res.status(201).json(shapeNotification(notification))
  } catch (err) {
    console.error('createNotification error:', err.message)
    return res.status(500).json({ error: 'Failed to create notification' })
  }
}

// ─── DELETE /api/notifications/:id ────────────────────────────────────────────
// Admin only — hard delete a specific notification.
module.exports.deleteNotification = async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid notification id' })
  }

  try {
    await prisma.notification.delete({ where: { id } })
    return res.json({ message: 'Notification deleted' })
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Notification not found' })
    }
    console.error('deleteNotification error:', err.message)
    return res.status(500).json({ error: 'Failed to delete notification' })
  }
}

// ─── DELETE /api/notifications ────────────────────────────────────────────────
// Admin only — bulk delete notifications older than N hours (default 48).
module.exports.deleteOldNotifications = async (req, res) => {
  const hours = Math.max(1, Number(req.query.hours) || 48)
  const cutoff = new Date()
  cutoff.setHours(cutoff.getHours() - hours)

  try {
    const { count } = await prisma.notification.deleteMany({
      where: { timestamp: { lt: cutoff } },
    })
    return res.json({
      deleted: count,
      message: `Deleted ${count} notifications older than ${hours} hours`,
    })
  } catch (err) {
    console.error('deleteOldNotifications error:', err.message)
    return res.status(500).json({ error: 'Failed to delete old notifications' })
  }
}