const express  = require('express')
const bcrypt   = require('bcryptjs')
const prisma   = require('../lib/prisma')
const { createToken }  = require('../lib/jwt')
const { authenticate } = require('../middleware/auth')

const router = express.Router()

router.post('/login', async (req, res) => {
  const { username, password, role } = req.body

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' })
  }

  try {
    const user = await prisma.staff.findFirst({
      where: { username, role, is_active: true }
    })

    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.status(400).json({ error: 'Invalid credentials' })
    }
    const token = createToken(user)

    res.cookie('token', token, {
      httpOnly: true,
      secure:   false,
      sameSite: 'lax',
      maxAge:   8 * 60 * 60 * 1000,
    })
    res.json({
      user: {
        id:       user.id,
        username: user.username,
        role:     user.role,
      }
    })

  } catch (err) {
    console.error('Login error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token')
  res.json({ message: 'Logged out successfully' })
})

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user })
})

module.exports = router