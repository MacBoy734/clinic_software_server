const { verifyToken } = require('../lib/jwt')
const prisma = require('../lib/prisma')

// Verify JWT cookie on every protected request
async function authenticate(req, res, next) {
  const token = req.cookies?.token
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const decoded = verifyToken(token)

    // ── Live check: still active? ─────────────────────────────
    const staff = await prisma.staff.findUnique({
      where: { id: decoded.id },
      select: { is_active: true, role: true, username: true }
    })

    if (!staff || !staff.is_active) {
      res.clearCookie('token')
      return res.status(403).json({ error: 'Account deactivated. Contact admin.' })
    }

    req.user = {
      id: decoded.id,
      username: staff.username,
      role: staff.role,
    }

    next()
  } catch {
    res.clearCookie('token')
    res.status(401).json({ error: 'Invalid token' })
  }
}

// Check role permission
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'You do not have permission to perform this action'
      })
    }
    next()
  }
}

module.exports = { authenticate, authorize }