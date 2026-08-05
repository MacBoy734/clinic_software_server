const redis = require('./redis')

// Guard — skip Redis calls if not connected yet
function isReady() {
  return redis.status === 'ready'
}

async function get(key) {
  if (!isReady()) return null
  const data = await redis.get(key)
  return data ? JSON.parse(data) : null
}

async function set(key, value, ttlSeconds) {
  if (!isReady()) return
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
}

async function del(...keys) {
  if (!isReady()) return
  if (keys.length > 0) await redis.del(...keys)
}

async function delPattern(pattern) {
  if (!isReady()) return
  const keys = await redis.keys(pattern)
  if (keys.length > 0) await redis.del(...keys)
}

module.exports = { get, set, del, delPattern }