const cron = require('node-cron')
const prisma = require('./prisma')

// Runs every day at midnight
cron.schedule('0 0 * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const { count } = await prisma.notification.deleteMany({
      where: { timestamp: { lt: cutoff } }
    })

    console.log(`[cron] Deleted ${count} old notifications`)
  } catch (err) {
    console.error('[cron] Failed to delete notifications:', err.message)
  }
})