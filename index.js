require('dotenv').config()
const express = require('express')
const cookieParser = require('cookie-parser')
const http = require('http')
const { initSocket } = require('./utils/socket')
const { standardLimit } = require('./utils/rateLimit')

const authRoutes = require('./routes/auth')
const adminRoutes = require('./routes/admin')

const app = express()
const server = http.createServer(app)

require('./lib/cron')
require('./lib/redis')
const { getSettings } = require('./lib/settings')
const PORT = process.env.PORT || 5000

initSocket(server)

// ─── Core Middleware ─────────────────────────────────────────────────────────
app.use(express.json())
app.use(cookieParser())
app.use(standardLimit)

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'API running' }))

app.use('/api/auth', authRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/reception', require('./routes/reception'))
app.use('/api/doctor', require('./routes/consultation'))
app.use('/api/lab', require('./routes/lab'))
app.use('/api/pharmacy', require('./routes/pharmacy'))
app.use('/api/expenses', require('./routes/expenses'))
app.use('/api/notifications', require('./routes/notifications'))

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.path} not found` })
})

// ─── Error Handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  const status = err.status || err.statusCode || 500
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
})

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  await getSettings()
  console.log(`Server on port ${PORT}`)
})