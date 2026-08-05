const jwt = require('jsonwebtoken')

const SECRET = process.env.JWT_SECRET

const createToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email:  user.email,
      role:   user.role,
      username:   user.username,
    },
    SECRET,
    { expiresIn: '8h' }
  )
}

const verifyToken = (token) => {
  return jwt.verify(token, SECRET)
}

module.exports = { createToken, verifyToken }