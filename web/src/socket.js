import { io } from 'socket.io-client'

let socket

export function getSocket() {
  if (!socket) {
    socket = io({
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 8,
      transports: ['websocket', 'polling'],
    })
  }
  return socket
}

export const nameKey = 'watch-room-name'
export const lastRoomKey = 'watch-room-last'

export function tokenKey(roomId) {
  return `watch-room-host:${roomId}`
}

export function entryKey(roomId) {
  return `watch-room-entry:${roomId}`
}

export function passwordKey(roomId) {
  return `watch-room-password:${roomId}`
}

export function hasEntry(roomId) {
  return sessionStorage.getItem(entryKey(roomId)) === '1' && Boolean(localStorage.getItem(nameKey))
}
