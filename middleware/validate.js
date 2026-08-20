const { z } = require('zod')

function validate(schemas = {}) {
  return async (req, res, next) => {
    try {
      const tasks = []

      if (schemas.body) {
        tasks.push(schemas.body.parseAsync(req.body).then(v => { req.body = v }))
      }
      if (schemas.query) {
        tasks.push(schemas.query.parseAsync(req.query).then(v => { req.query = v }))
      }
      if (schemas.params) {
        tasks.push(schemas.params.parseAsync(req.params).then(v => { req.params = v }))
      }

      await Promise.all(tasks)
      next()
    } catch (err) {
      if (err instanceof z.ZodError) {
        // FIX: use err.issues, not err.errors
        const message = err.issues
          .map(e => {
            const path = e.path.join('.')
            return path ? `${path}: ${e.message}` : e.message
          })
          .join('; ')

        return res.status(400).json({ error: message })
      }
      next(err)
    }
  }
}

module.exports = validate