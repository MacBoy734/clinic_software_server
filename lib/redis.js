const Redis = require('ioredis')

const redis = new Redis({
  host:     process.env.REDIS_HOST || 'localhost',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,

  // Stop retrying after 3 attempts — don't spam the console
  maxRetriesPerRequest: 1,

  // Wait up to 3s between reconnect attempts, stop after 5 tries
  retryStrategy(times) {
    if (times > 5) {
      console.error('[redis] Could not connect after 5 attempts — running without cache')
      return null  // null = stop retrying
    }
    return Math.min(times * 200, 3000)
  },

  // Don't throw on connect failure — let the app start without Redis
  lazyConnect: true,
  enableOfflineQueue: false,  // don't queue commands when disconnected
})

redis.on('connect',     () => console.log('[redis] Connected'))
redis.on('error',       (err) => {
  // Only log unique messages — suppress the flood of repeated errors
  if (!redis._lastErr || redis._lastErr !== err.message) {
    redis._lastErr = err.message
    console.error('[redis] Error:', err.message)
  }
})
redis.on('reconnecting', () => console.log('[redis] Reconnecting...'))

// Try to connect now — but don't crash if it fails
redis.connect().catch(() => {
  console.warn('[redis] Starting without Redis — falling back to DB for all cache reads')
})

module.exports = redis