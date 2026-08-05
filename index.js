// ─── Imports ──────────────────────────────────────────────────────────────────
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const http = require('http')
const { initSocket } = require('./utils/socket') // ← ./ not @/

const authRoutes = require('./routes/auth')
const adminRoutes = require('./routes/admin')

const app = express()
const server = http.createServer(app)
require('./lib/cron') // ← run cron jobs
const redis   = require('./lib/redis')   // ← import triggers connection
const { getSettings } = require('./lib/settings')
const PORT = process.env.PORT || 5000

// ─── Init Socket.io ───────────────────────────────────────────────────────────
initSocket(server) // ← must be before server.listen

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}))
app.use(express.json())
app.use(cookieParser())

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the City Health Clinic API!' })
})
app.use('/api/auth', authRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/reception', require('./routes/reception'))
app.use('/api/doctor', require('./routes/consultation'))
app.use('/api/lab', require('./routes/lab'))
app.use('/api/pharmacy', require('./routes/pharmacy'))
app.use('/api/expenses', require('./routes/expenses'))
app.use('/api/notifications', require('./routes/notifications'))

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.path} not found` })
})

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => { // ← server.listen not app.listen
  await getSettings()
  console.log(`\n City Health Clinic Server`)
  console.log(` Running on http://localhost:${PORT}`)
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`)
})