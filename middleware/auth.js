const { verifyToken } = require('../lib/jwt')

// Verify JWT cookie on every protected request
const authenticate = (req, res, next) => {
  const token = req.cookies.token

  if (!token) {
    return res.status(401).json({ error: 'Not logged in' })
  }

  try {
    const decoded = verifyToken(token)
    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ error: 'Session expired, please login again' })
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