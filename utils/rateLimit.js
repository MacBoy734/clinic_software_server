const rateLimit = require('express-rate-limit')

// ── Standard API limit ──────────────────────────────────────────
const standardLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down' },
  skip: (req) => req.path === '/api/health', 
})

// ── Strict limit for auth ───────────────────────────────────────
const authLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
})

// ── Financial limit (payments, waivers) ────────────────────────
// 20 payment actions per 5 minutes per IP
const financialLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests — please wait' },
})

module.exports = { standardLimit, authLimit, financialLimit }