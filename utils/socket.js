// src/socket.js
const { Server } = require('socket.io')

let io

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  })

  io.on('connection', (socket) => {
    // Each role joins its own room
    socket.on('join', (role) => {
      socket.join(role)
    })
    socket.on('disconnect', (reason) => {
  console.log(`Socket disconnected: ${socket.id} — reason: ${reason}`)
})
  })

  return io
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized — call initSocket first')
  return io
}

module.exports = { initSocket, getIO }