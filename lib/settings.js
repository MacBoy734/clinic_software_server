const cache  = require('./cache')
const prisma = require('./prisma')
const TTL    = require('./ttl')

const KEY = 'cache:settings'
const SETTINGS_ID = 1

// Same shape on cache-hit and cache-miss paths. Date -> ISO string, Decimal -> string.
function normalize(row) {
  return JSON.parse(JSON.stringify(row))
}

async function getOrCreateSettingsRow() {
  return prisma.clinicSettings.upsert({
    where:  { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID },
  })
}

async function getSettings() {
  try {
    const cached = await cache.get(KEY)
    if (cached) return cached
  } catch (err) {
    console.error('settings cache read failed, falling back to DB:', err.message)
  }

  const row = normalize(await getOrCreateSettingsRow())

  try {
    await cache.set(KEY, row, TTL.SETTINGS)
  } catch (err) {
    console.error('settings cache write failed:', err.message)
  }

  return row
}

async function getSetting(field, fallback = null) {
  const s = await getSettings()
  return s?.[field] ?? fallback
}

async function invalidateSettings() {
  try {
    await cache.del(KEY)
  } catch (err) {
    console.error('settings cache invalidation failed:', err.message)
  }
}

module.exports = { getSettings, getSetting, invalidateSettings, SETTINGS_ID }