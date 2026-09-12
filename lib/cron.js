const cron = require('node-cron')
const prisma = require('./prisma')
const { createNotification, NOTIFICATION_TYPES } = require('../utils/helpers')

const LOCK = { PRODUCT: 1, CUSTOMER: 2 }
 
function lockProduct(tx, productId) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK.PRODUCT}::int, ${productId}::int)`
}
 

// ─── Notification cleanup ────────────────────────────────────────────────────

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


async function reconcileStock() {
  const rows = await prisma.$queryRaw`
    SELECT p.id, p.name, p.current_stock::int,
           COALESCE(b.batch_sum, 0)::int  AS batch_sum,
           COALESCE(m.ledger_sum, 0)::int AS ledger_sum
    FROM products p
    LEFT JOIN (SELECT product_id, SUM(quantity) AS batch_sum  FROM product_batches  GROUP BY product_id) b ON b.product_id = p.id
    LEFT JOIN (SELECT product_id, SUM(delta)    AS ledger_sum FROM stock_movements GROUP BY product_id) m ON m.product_id = p.id
    WHERE p.current_stock <> COALESCE(b.batch_sum, 0)
       OR COALESCE(b.batch_sum, 0) <> COALESCE(m.ledger_sum, 0)
  `

  const ledgerDrift = rows.filter((r) => r.batch_sum !== r.ledger_sum)
  const cacheDrift = rows.filter(
    (r) => r.batch_sum === r.ledger_sum && r.current_stock !== r.batch_sum
  )

  let healed = 0

  for (const r of cacheDrift) {
    // Per-product transaction. One failure must not abort the rest of the pass.
    try {
      await prisma.$transaction(async (tx) => {
        await lockProduct(tx, r.id)

        
        const [fresh] = await tx.$queryRaw`
          SELECT p.current_stock::int AS current_stock,
                 COALESCE((SELECT SUM(quantity) FROM product_batches WHERE product_id = p.id), 0)::int AS batch_sum,
                 COALESCE((SELECT SUM(delta)    FROM stock_movements WHERE product_id = p.id), 0)::int AS ledger_sum
          FROM products p WHERE p.id = ${r.id}
        `
        if (!fresh) return
        if (fresh.batch_sum !== fresh.ledger_sum) return  
        if (fresh.current_stock === fresh.batch_sum) return 

        await tx.product.update({
          where: { id: r.id },
          data: { current_stock: fresh.batch_sum },
        })

        
        await tx.auditLog.create({
          data: {
            action: 'Stock Cache Healed',
            description:
              `${r.name} (#${r.id}): current_stock ${fresh.current_stock} → ${fresh.batch_sum} ` +
              `(recomputed from batches; ledger agrees). A write path is not ` +
              `maintaining the cache — find it.`,
            category: 'stock',
            entity: 'Product',
            entity_id: r.id,
            user: 'System',
          },
        })
      })
      healed++
    } catch (err) {
      console.error(`[cron] heal failed for product ${r.id}:`, err.message)
    }
  }

  for (const r of ledgerDrift) {
    try {
      await prisma.auditLog.create({
        data: {
          action: 'Stock Ledger Drift',
          description:
            `${r.name} (#${r.id}): batch_sum=${r.batch_sum} ledger_sum=${r.ledger_sum}. ` +
            `NOT auto-repaired — needs manual investigation.`,
          category: 'stock',
          entity: 'Product',
          entity_id: r.id,
          user: 'System',
        },
      })
    } catch (err) {
      console.error(`[cron] drift log failed for product ${r.id}:`, err.message)
    }
  }

  if (ledgerDrift.length) {
    await createNotification({
      targetRoles: ['admin'],
      type: NOTIFICATION_TYPES.STOCK_DRIFT,
      title: 'Stock ledger drift',
      message:
        `${ledgerDrift.length} product(s) have batch quantities the ledger cannot ` +
        `explain. This is a software defect, not shrinkage. Stocktake results ` +
        `cannot be trusted until it is resolved: ` +
        ledgerDrift.slice(0, 3).map((r) => r.name).join(', ') +
        (ledgerDrift.length > 3 ? `, +${ledgerDrift.length - 3} more` : ''),
    }).catch((err) => console.error('[cron] drift notification failed:', err.message))
  }

  return { scanned: rows.length, healed, unresolved: ledgerDrift.length }
}

cron.schedule('0 0 * * *', async () => {
  try {
    const result = await reconcileStock()
    console.log(
      `[cron] Stock reconciliation — ${result.healed} cache healed, ` +
      `${result.unresolved} ledger drift unresolved`
    )
  } catch (err) {
    console.error('[cron] Stock reconciliation failed:', err.message)
  }
})

module.exports = { reconcileStock }