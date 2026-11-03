import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000
const CHAT_GAP_MS = 400
const MESSAGE_LIMIT = 100

function randomId() {
  const bytes = randomBytes(6)
  let id = ''
  for (let index = 0; index < 6; index += 1) {
    id += ALPHABET[bytes[index] % ALPHABET.length]
  }
  return id
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  if (!stored) return password === ''
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const actual = scryptSync(String(password), salt, 32)
  const expected = Buffer.from(hash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function tokensEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

function cleanName(input) {
  const name = String(input || '').replace(/\s+/g, ' ').trim()
  if (!name) return { error: '请填写名字' }
  if ([...name].length > 24) return { error: '名字最多 24 个字' }
  return { name }
}

function cleanTitle(input) {
  const title = String(input || '').replace(/\s+/g, ' ').trim()
  if (!title) return { title: '未命名放映室' }
  if ([...title].length > 40) return { error: '标题最多 40 个字' }
  return { title }
}

function cleanPassword(input) {
  const password = String(input ?? '')
  if ([...password].length > 64) return { error: '密码最多 64 个字符' }
  return { password }
}

function normalizeRoomId(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function cleanMediaUrl(input) {
  const url = String(input || '').trim()
  if (!url) return { error: '请填写视频地址' }
  if ([...url].length > 2000) return { error: '视频地址太长了' }
  if (url.startsWith('/') && !url.startsWith('//')) return { url }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: '只支持 http 或 https 视频' }
    }
    return { url: parsed.toString() }
  } catch {
    return { error: '视频地址无法识别' }
  }
}

function cleanPosition(value) {
  const position = Number(value)
  if (!Number.isFinite(position) || position < 0 || position > 24 * 60 * 60) {
    return { error: '播放进度无效' }
  }
  return { position }
}

function livePosition(playback, at) {
  if (!playback) return 0
  if (!playback.playing) return playback.position
  return playback.position + Math.max(0, (at - playback.updatedAt) / 1000)
}

export function createStore(options = {}) {
  const now = options.now ?? (() => Date.now())
  const maxMembers = options.maxMembers ?? 12
  const maxRooms = options.maxRooms ?? 100
  const makeId = options.idFactory ?? randomId
  const rooms = new Map()
  const socketRoom = new Map()

  function snapshot(room) {
    const members = [...room.members.entries()]
      .map(([id, member]) => ({
        id,
        name: member.name,
        role: member.role,
        joinedAt: member.joinedAt,
        voice: Boolean(member.inVoice),
        muted: Boolean(member.muted),
      }))
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'host' ? -1 : 1
        return a.joinedAt - b.joinedAt
      })
      .map(({ id, name, role, voice, muted }) => ({ id, name, role, voice, muted }))

    return {
      id: room.id,
      title: room.title,
      hasPassword: Boolean(room.passwordHash),
      screening: room.screening,
      hostAway: room.hostSocketId === null,
      playback: room.playback ? { ...room.playback } : null,
      members,
      messages: room.messages,
    }
  }

  function pushMessage(room, message) {
    room.messages.push({
      id: String(room.seq),
      name: message.name,
      text: message.text,
      system: Boolean(message.system),
      at: now(),
    })
    room.seq += 1
    if (room.messages.length > MESSAGE_LIMIT) room.messages.shift()
  }

  function memberOf(socketId) {
    const roomId = socketRoom.get(socketId)
    if (!roomId) return null
    const room = rooms.get(roomId)
    if (!room) return null
    const member = room.members.get(socketId)
    if (!member) return null
    return { room, member }
  }

  function allocateId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = makeId()
      if (id && !rooms.has(id)) return id
    }
    return null
  }

  function create({ name, title, password } = {}) {
    const person = cleanName(name)
    if (person.error) return person
    const label = cleanTitle(title)
    if (label.error) return label
    const secret = cleanPassword(password)
    if (secret.error) return secret
    if (rooms.size >= maxRooms) return { error: '服务器房间已满，请稍后再试' }

    const id = allocateId()
    if (!id) return { error: '现在创建不了房间，请再试一次' }

    const room = {
      id,
      title: label.title,
      passwordHash: secret.password ? hashPassword(secret.password) : '',
      hostToken: randomBytes(24).toString('base64url'),
      hostSocketId: null,
      screening: false,
      playback: null,
      members: new Map(),
      messages: [],
      seq: 1,
      createdAt: now(),
      emptyAt: 0,
      hostEverConnected: false,
    }
    rooms.set(id, room)
    return { hostToken: room.hostToken, state: snapshot(room) }
  }

  function claimHost(room, socketId, name) {
    const existing = room.members.get(socketId)
    if (!existing && room.members.size >= maxMembers && room.hostSocketId) {
      return { error: '这个放映室已满' }
    }

    const previousHostId = room.hostSocketId
    const wasScreening = room.screening
    if (previousHostId && previousHostId !== socketId) {
      const previous = room.members.get(previousHostId)
      if (previous) previous.role = 'viewer'
      room.screening = false
    }

    room.hostSocketId = socketId
    room.emptyAt = 0
    const cameBack = room.hostEverConnected && previousHostId === null && !existing && room.members.size > 0
    room.members.set(socketId, {
      name,
      role: 'host',
      joinedAt: existing?.joinedAt ?? now(),
      lastChatAt: existing?.lastChatAt ?? 0,
      inVoice: existing?.inVoice ?? false,
      muted: existing?.muted ?? false,
    })
    socketRoom.set(socketId, room.id)
    room.hostEverConnected = true

    if (cameBack) pushMessage(room, { name: '放映室', text: '主持人回来了', system: true })
    if (!existing && previousHostId && previousHostId !== socketId) {
      pushMessage(room, {
        name: '放映室',
        text: wasScreening ? '主持人换到了新的页面，请重新开始放映' : '主持人换到了新的页面',
        system: true,
      })
    }
    return { role: 'host', state: snapshot(room) }
  }

  function join({ roomId, name, password, hostToken, socketId } = {}) {
    if (!socketId) return { error: '连接还没准备好' }
    const id = normalizeRoomId(roomId)
    const room = rooms.get(id)
    if (!room) return { error: '找不到这个放映室' }

    const person = cleanName(name)
    if (person.error) return person

    if (hostToken) {
      if (!tokensEqual(String(hostToken), room.hostToken)) {
        return { error: '主持人身份已失效，请用密码重新加入' }
      }
      return claimHost(room, socketId, person.name)
    }

    if (!verifyPassword(String(password ?? ''), room.passwordHash)) {
      return { error: '密码不正确' }
    }

    const existing = room.members.get(socketId)
    if (existing) {
      existing.name = person.name
      return { role: existing.role, state: snapshot(room) }
    }
    if (room.members.size >= maxMembers) return { error: '这个放映室已满' }

    room.members.set(socketId, {
      name: person.name,
      role: 'viewer',
      joinedAt: now(),
      lastChatAt: 0,
      inVoice: false,
      muted: false,
    })
    socketRoom.set(socketId, room.id)
    room.emptyAt = 0
    pushMessage(room, { name: '放映室', text: `${person.name} 进入了放映室`, system: true })
    return { role: 'viewer', state: snapshot(room) }
  }

  function leave(socketId, { silent = false } = {}) {
    const found = memberOf(socketId)
    if (!found) return null
    const { room, member } = found
    const wasHost = room.hostSocketId === socketId
    const wasInVoice = Boolean(member.inVoice)
    room.members.delete(socketId)
    socketRoom.delete(socketId)

    if (wasHost) {
      room.hostSocketId = null
      room.screening = false
      if (room.playback?.playing) {
        room.playback = {
          url: room.playback.url,
          playing: false,
          position: livePosition(room.playback, now()),
          updatedAt: now(),
        }
      }
    }

    if (room.members.size === 0) {
      room.emptyAt = now()
      return { roomId: room.id, deleted: false, empty: true, wasHost, wasInVoice, state: snapshot(room) }
    }

    if (!silent) {
      if (wasHost) {
        pushMessage(room, { name: '放映室', text: '主持人暂时离开，放映已暂停', system: true })
      } else {
        pushMessage(room, { name: '放映室', text: `${member.name} 离开了放映室`, system: true })
      }
    }

    return { roomId: room.id, deleted: false, wasHost, wasInVoice, state: snapshot(room) }
  }

  function chat({ socketId, text } = {}) {
    const found = memberOf(socketId)
    if (!found) return { error: '你还不在放映室里' }
    const { room, member } = found
    const body = String(text || '').replace(/\s+/g, ' ').trim()
    if (!body) return { error: '写点什么再发送' }
    if ([...body].length > 500) return { error: '这条消息太长了' }
    if (now() - member.lastChatAt < CHAT_GAP_MS) return { error: '发送太快了' }
    member.lastChatAt = now()
    pushMessage(room, { name: member.name, text: body, system: false })
    return { ok: true, state: snapshot(room) }
  }

  function setScreening({ socketId, active } = {}) {
    const found = memberOf(socketId)
    if (!found) return { error: '你还不在放映室里' }
    if (found.member.role !== 'host') return { error: '只有主持人可以放映' }
    const { room } = found
    const next = Boolean(active)
    if (room.screening === next) return { ok: true, state: snapshot(room) }
    room.screening = next
    pushMessage(room, {
      name: '放映室',
      text: next ? '放映开始了' : '放映结束了',
      system: true,
    })
    return { ok: true, state: snapshot(room) }
  }

  function setPlayback({ socketId, url, playing, position, clear } = {}) {
    const found = memberOf(socketId)
    if (!found) return { error: '你还不在放映室里' }
    if (found.member.role !== 'host') return { error: '只有主持人可以控制播放' }
    const { room } = found

    if (clear) {
      if (!room.playback) return { ok: true, state: snapshot(room) }
      room.playback = null
      pushMessage(room, { name: '放映室', text: '同步播放结束了', system: true })
      return { ok: true, state: snapshot(room) }
    }

    if (typeof url === 'string') {
      const media = cleanMediaUrl(url)
      if (media.error) return media
      const changed = room.playback?.url !== media.url
      room.playback = {
        url: media.url,
        playing: false,
        position: 0,
        updatedAt: now(),
      }
      if (changed) pushMessage(room, { name: '放映室', text: '开始同步播放', system: true })
      return { ok: true, state: snapshot(room) }
    }

    if (!room.playback) return { error: '还没有选择视频' }
    const point = cleanPosition(position)
    if (point.error) return point
    room.playback = {
      url: room.playback.url,
      playing: Boolean(playing),
      position: point.position,
      updatedAt: now(),
    }
    return { ok: true, state: snapshot(room) }
  }

  function joinVoice(socketId) {
    const found = memberOf(socketId)
    if (!found) return { error: '你还不在放映室里' }
    const { room, member } = found
    member.inVoice = true
    member.muted = false
    const peers = [...room.members.entries()]
      .filter(([id, person]) => person.inVoice && id !== socketId)
      .map(([id]) => id)
    return { ok: true, peers, state: snapshot(room) }
  }

  function leaveVoice(socketId) {
    const found = memberOf(socketId)
    if (!found || !found.member.inVoice) return null
    found.member.inVoice = false
    found.member.muted = false
    return { roomId: found.room.id, state: snapshot(found.room) }
  }

  function setVoiceMuted({ socketId, muted } = {}) {
    const found = memberOf(socketId)
    if (!found) return { error: '你还不在放映室里' }
    if (!found.member.inVoice) return { error: '你还没加入语音' }
    found.member.muted = Boolean(muted)
    return { ok: true, state: snapshot(found.room) }
  }

  function bothInVoice(leftId, rightId) {
    if (!sameRoom(leftId, rightId)) return false
    const left = memberOf(leftId)
    const right = memberOf(rightId)
    return Boolean(left?.member.inVoice && right?.member.inVoice)
  }

  function beginKick({ socketId, targetId } = {}) {
    const found = memberOf(socketId)
    if (!found || found.member.role !== 'host') return { error: '只有主持人可以移出观众' }
    if (typeof targetId !== 'string' || !targetId) return { error: '找不到这个观众' }
    if (targetId === socketId) return { error: '不能移出自己' }
    const target = memberOf(targetId)
    if (!target || target.room.id !== found.room.id) return { error: '对方不在这个放映室' }
    pushMessage(found.room, {
      name: '放映室',
      text: `${target.member.name} 被移出放映室`,
      system: true,
    })
    return { ok: true, targetId, roomId: found.room.id }
  }

  function sameRoom(leftId, rightId) {
    const left = socketRoom.get(leftId)
    const right = socketRoom.get(rightId)
    return Boolean(left && right && left === right && leftId !== rightId)
  }

  function hostSocketId(roomId) {
    return rooms.get(roomId)?.hostSocketId ?? null
  }

  function hostOf({ roomId, hostToken } = {}) {
    const id = normalizeRoomId(roomId)
    const room = rooms.get(id)
    if (!room) return { error: '没有这个放映室' }
    if (!tokensEqual(String(hostToken || ''), room.hostToken)) return { error: '只有主持人可以上传影片' }
    return { ok: true, roomId: id }
  }

  function claimUpload({ roomId, hostToken, file } = {}) {
    const allowed = hostOf({ roomId, hostToken })
    if (allowed.error) return allowed
    const room = rooms.get(allowed.roomId)
    const previous = room.uploadFile || ''
    room.uploadFile = file
    return { ok: true, previous }
  }

  function sweep() {
    const current = now()
    const removed = []
    for (const [id, room] of rooms) {
      if (room.members.size > 0) continue
      const since = room.emptyAt || room.createdAt
      if (current - since <= EMPTY_ROOM_TTL_MS) continue
      if (room.uploadFile) removed.push(room.uploadFile)
      rooms.delete(id)
    }
    return removed
  }

  return {
    create,
    join,
    leave,
    chat,
    setScreening,
    setPlayback,
    joinVoice,
    leaveVoice,
    setVoiceMuted,
    bothInVoice,
    beginKick,
    sameRoom,
    hostSocketId,
    hostOf,
    claimUpload,
    sweep,
  }
}
