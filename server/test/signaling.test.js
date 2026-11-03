import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { io } from 'socket.io-client'
import { start } from '../src/index.js'

let app
let port

function connect() {
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 4000)
    socket.on('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.on('connect_error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function ask(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve)
  })
}

describe('signaling server', () => {
  before(async () => {
    app = start(0)
    await new Promise((resolve) => app.httpServer.once('listening', resolve))
    port = app.httpServer.address().port
  })

  after(async () => {
    await app.close()
  })

  it('creates a room, chats, relays a signal, and kicks a viewer', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => res.json())
    assert.equal(health.ok, true)

    const denied = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ', title: '测试' }),
    })
    assert.equal(denied.status, 400)

    const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '阿宁', title: '联调', password: 'pine' }),
    }).then((res) => res.json())
    assert.ok(created.roomId)
    assert.ok(created.hostToken)

    const host = await connect()
    const viewer = await connect()

    const wrong = await ask(viewer, 'join-room', {
      roomId: created.roomId,
      name: '小林',
      password: 'nope',
    })
    assert.equal(wrong.error, '密码不正确')

    const hostJoin = await ask(host, 'join-room', {
      roomId: created.roomId,
      name: '阿宁',
      hostToken: created.hostToken,
    })
    assert.equal(hostJoin.role, 'host')

    const viewerJoined = new Promise((resolve) => host.once('room-state', resolve))
    const viewerJoin = await ask(viewer, 'join-room', {
      roomId: created.roomId,
      name: '小林',
      password: 'pine',
    })
    assert.equal(viewerJoin.role, 'viewer')
    const seen = await viewerJoined
    assert.equal(seen.members.length, 2)

    const peerJoined = new Promise((resolve) => host.once('peer-joined', resolve))
    const late = await connect()
    const lateJoin = await ask(late, 'join-room', {
      roomId: created.roomId,
      name: '晚到',
      password: 'pine',
    })
    assert.equal(lateJoin.role, 'viewer')
    const peer = await peerJoined
    assert.equal(peer.id, late.id)

    const chatSeen = new Promise((resolve) => {
      viewer.on('room-state', (state) => {
        if (state.messages.some((item) => item.text === '开始了')) resolve(state)
      })
    })
    const chat = await ask(viewer, 'chat', { text: '开始了' })
    assert.equal(chat.ok, true)
    await chatSeen

    const forbidden = await ask(viewer, 'screening', { active: true })
    assert.equal(forbidden.error, '只有主持人可以放映')
    const screening = await ask(host, 'screening', { active: true })
    assert.equal(screening.state.screening, true)

    const signalSeen = new Promise((resolve) => viewer.once('signal', resolve))
    host.emit('signal', {
      to: viewer.id,
      sessionId: 'session-1',
      description: { type: 'offer', sdp: 'v=0' },
    })
    const signal = await signalSeen
    assert.equal(signal.from, host.id)
    assert.equal(signal.description.sdp, 'v=0')

    const kicked = new Promise((resolve) => viewer.once('kicked', resolve))
    const kick = await ask(host, 'kick', { targetId: viewer.id })
    assert.equal(kick.ok, true)
    const notice = await kicked
    assert.match(notice.message, /移出/)

    late.disconnect()
    host.disconnect()
    viewer.disconnect()
  })
})
