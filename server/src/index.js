import { createReadStream, readFileSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import { MEDIA_TYPES, etagMatches, fileEtag, isMediaPath, parseByteRange } from './media-file.js'
import { createStore } from './store.js'
import { MAX_UPLOAD_BYTES, saveUpload, uploadExtension } from './uploads.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  ...MEDIA_TYPES,
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 20_000) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

function withinRoot(root, full) {
  const base = root.endsWith(sep) ? root : root + sep
  return full === root || full.startsWith(base)
}

function writeHead(res, status, headers, method) {
  res.writeHead(status, headers)
  if (method === 'HEAD' || status === 304 || status === 416) res.end()
}

async function serveStatic(req, res, staticDir, pathname) {
  const root = normalize(staticDir)
  let rel = pathname
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400)
    res.end('Bad request')
    return
  }
  if (rel.includes('\0')) {
    res.writeHead(400)
    res.end('Bad request')
    return
  }

  const requested = rel === '/' ? '/index.html' : rel
  const full = normalize(join(root, requested))
  if (!withinRoot(root, full)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const info = await stat(full)
    if (!info.isFile()) throw new Error('not a file')
    const extension = extname(full).toLowerCase()
    const type = MIME[extension] || 'application/octet-stream'
    const media = isMediaPath(requested)
    const etag = fileEtag(info.size, info.mtimeMs)
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      etag,
      'cache-control': extension === '.html' ? 'no-cache' : media ? 'public, max-age=86400' : 'public, max-age=31536000, immutable',
    }
    if (etagMatches(req.headers['if-none-match'], etag)) {
      writeHead(res, 304, headers, req.method)
      return
    }

    const range = parseByteRange(req.headers.range, info.size)
    if (range?.error) {
      writeHead(res, 416, { 'content-range': `bytes */${info.size}` }, req.method)
      return
    }

    if (range) {
      headers['content-length'] = String(range.end - range.start + 1)
      headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`
      writeHead(res, 206, headers, req.method)
      if (req.method === 'HEAD') return
      createReadStream(full, { start: range.start, end: range.end }).pipe(res)
      return
    }

    headers['content-length'] = String(info.size)
    writeHead(res, 200, headers, req.method)
    if (req.method === 'HEAD') return
    createReadStream(full).pipe(res)
  } catch {
    if (requested.startsWith('/assets/') || requested.startsWith('/api/') || isMediaPath(requested)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    })
    createReadStream(join(root, 'index.html')).pipe(res)
  }
}

function cleanSignal(payload) {
  if (!payload || typeof payload !== 'object') return null
  const to = typeof payload.to === 'string' ? payload.to : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.slice(0, 80) : ''
  if (!to || !sessionId) return null

  let description = null
  if (payload.description && typeof payload.description === 'object') {
    const { type, sdp } = payload.description
    if ((type === 'offer' || type === 'answer') && typeof sdp === 'string' && sdp.length < 100_000) {
      description = { type, sdp }
    }
  }

  const candidate = payload.candidate && typeof payload.candidate === 'object' ? payload.candidate : null
  if (!description && !candidate) return null
  return { to, sessionId, description, candidate }
}

export function start(port = Number(process.env.PORT || 8787), options = {}) {
  const staticDir = options.staticDir ?? process.env.STATIC_DIR ?? ''
  const uploadDir = options.uploadDir ?? resolve(process.cwd(), 'data', 'uploads')
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES
  const store = createStore()
  const uploading = new Set()
  const timer = setInterval(() => {
    for (const file of store.sweep()) {
      rm(join(uploadDir, file), { force: true }).catch(() => {})
    }
  }, 60_000)
  timer.unref?.()

  const requestHandler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      try {
        const body = await readJson(req)
        const result = store.create(body)
        if (result.error) {
          sendJson(res, 400, { error: result.error })
          return
        }
        sendJson(res, 201, {
          roomId: result.state.id,
          hostToken: result.hostToken,
          state: result.state,
        })
      } catch {
        sendJson(res, 400, { error: '请求无法解析' })
      }
      return
    }

    const uploadMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/video$/)
    if (req.method === 'POST' && uploadMatch) {
      const roomId = uploadMatch[1].toUpperCase()
      let filename = ''
      try {
        filename = decodeURIComponent(String(req.headers['x-file-name'] || ''))
      } catch {
        filename = ''
      }
      const extension = uploadExtension(filename, req.headers['content-type'])
      if (!extension) {
        req.resume()
        sendJson(res, 400, { error: '请上传 mp4、webm 或 mov' })
        return
      }
      if (uploading.has(roomId)) {
        req.resume()
        sendJson(res, 409, { error: '上一部影片还在上传' })
        return
      }
      const allowed = store.hostOf({ roomId, hostToken: req.headers['x-host-token'] })
      if (allowed.error) {
        req.resume()
        sendJson(res, allowed.error === '没有这个放映室' ? 404 : 403, allowed)
        return
      }
      uploading.add(roomId)
      try {
        const saved = await saveUpload(req, uploadDir, extension, maxUploadBytes)
        if (saved.error) {
          sendJson(res, 400, saved)
          return
        }
        const claimed = store.claimUpload({
          roomId,
          hostToken: req.headers['x-host-token'],
          file: saved.name,
        })
        if (claimed.error) {
          await rm(join(uploadDir, saved.name), { force: true }).catch(() => {})
          sendJson(res, 403, claimed)
          return
        }
        if (claimed.previous) {
          await rm(join(uploadDir, claimed.previous), { force: true }).catch(() => {})
        }
        sendJson(res, 201, { url: `/uploads/${saved.name}` })
      } finally {
        uploading.delete(roomId)
      }
      return
    }

    if (url.pathname.startsWith('/uploads/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: '不支持这个请求' })
        return
      }
      const name = url.pathname.slice('/uploads/'.length)
      if (!/^[a-f0-9]{32}\.(mp4|m4v|webm|ogv|ogg|mov)$/.test(name)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      await serveStatic(req, res, uploadDir, `/${name}`)
      return
    }

    if (!staticDir) {
      sendJson(res, 404, { error: '这里没有页面，开发时请打开前端地址' })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: '不支持这个请求' })
      return
    }
    await serveStatic(req, res, staticDir, url.pathname)
  }
  const httpServer = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, requestHandler)
    : createHttpServer(requestHandler)

  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 1e6,
  })

  function reply(ack, payload) {
    if (typeof ack === 'function') ack(payload)
  }

  function detach(socket, options) {
    const result = store.leave(socket.id, options)
    if (!result) return null
    socket.leave(result.roomId)
    if (result.state?.members.length) {
      io.to(result.roomId).emit('room-state', result.state)
      const hostId = store.hostSocketId(result.roomId)
      if (hostId) io.to(hostId).emit('peer-left', { id: socket.id })
      if (result.wasInVoice) io.to(result.roomId).emit('voice-left', { id: socket.id })
    }
    return result
  }

  io.on('connection', (socket) => {
    socket.on('join-room', (payload = {}, ack) => {
      detach(socket)
      const result = store.join({
        roomId: payload.roomId,
        name: payload.name,
        password: payload.password,
        hostToken: payload.hostToken,
        socketId: socket.id,
      })
      if (result.error) {
        reply(ack, result)
        return
      }
      socket.join(result.state.id)
      reply(ack, { role: result.role, selfId: socket.id, state: result.state })
      socket.to(result.state.id).emit('room-state', result.state)
      if (result.role === 'viewer') {
        const hostId = store.hostSocketId(result.state.id)
        if (hostId) io.to(hostId).emit('peer-joined', { id: socket.id })
      }
    })

    socket.on('chat', (payload = {}, ack) => {
      const result = store.chat({ socketId: socket.id, text: payload.text })
      if (result.error) {
        reply(ack, result)
        return
      }
      io.to(result.state.id).emit('room-state', result.state)
      reply(ack, { ok: true })
    })

    socket.on('playback', (payload = {}, ack) => {
      const result = store.setPlayback({
        socketId: socket.id,
        url: payload.url,
        playing: payload.playing,
        position: payload.position,
        clear: payload.clear,
      })
      if (result.error) {
        reply(ack, result)
        return
      }
      io.to(result.state.id).emit('room-state', result.state)
      reply(ack, { ok: true, state: result.state })
    })

    socket.on('screening', (payload = {}, ack) => {
      const result = store.setScreening({ socketId: socket.id, active: payload.active })
      if (result.error) {
        reply(ack, result)
        return
      }
      io.to(result.state.id).emit('room-state', result.state)
      reply(ack, { ok: true, state: result.state })
    })

    socket.on('voice-join', (payload, ack) => {
      const replyTo = typeof payload === 'function' ? payload : ack
      const result = store.joinVoice(socket.id)
      if (result.error) {
        reply(replyTo, result)
        return
      }
      io.to(result.state.id).emit('room-state', result.state)
      reply(replyTo, { ok: true, peers: result.peers, state: result.state })
    })

    socket.on('voice-leave', (_, ack) => {
      const result = store.leaveVoice(socket.id)
      if (!result) {
        reply(ack, { ok: true })
        return
      }
      io.to(result.roomId).emit('room-state', result.state)
      socket.to(result.roomId).emit('voice-left', { id: socket.id })
      reply(ack, { ok: true })
    })

    socket.on('voice-mute', (payload = {}, ack) => {
      const result = store.setVoiceMuted({ socketId: socket.id, muted: payload.muted })
      if (result.error) {
        reply(ack, result)
        return
      }
      io.to(result.state.id).emit('room-state', result.state)
      reply(ack, { ok: true })
    })

    socket.on('voice-signal', (payload) => {
      const message = cleanSignal(payload)
      if (!message) return
      if (!store.bothInVoice(socket.id, message.to)) return
      io.to(message.to).emit('voice-signal', {
        from: socket.id,
        sessionId: message.sessionId,
        description: message.description,
        candidate: message.candidate,
      })
    })

    socket.on('kick', (payload = {}, ack) => {
      const result = store.beginKick({ socketId: socket.id, targetId: payload.targetId })
      if (result.error) {
        reply(ack, result)
        return
      }
      const target = io.sockets.sockets.get(result.targetId)
      reply(ack, { ok: true })
      if (!target) return
      target.emit('kicked', { message: '主持人已将你移出放映室' })
      detach(target, { silent: true })
      target.disconnect(true)
    })

    socket.on('signal', (payload) => {
      const message = cleanSignal(payload)
      if (!message) return
      if (!store.sameRoom(socket.id, message.to)) return
      io.to(message.to).emit('signal', {
        from: socket.id,
        sessionId: message.sessionId,
        description: message.description,
        candidate: message.candidate,
      })
    })

    socket.on('leave-room', (_, ack) => {
      detach(socket)
      reply(ack, { ok: true })
    })

    socket.on('disconnect', () => {
      detach(socket)
    })
  })

  httpServer.listen(port)

  return {
    store,
    io,
    httpServer,
    async close() {
      clearInterval(timer)
      io.disconnectSockets(true)
      httpServer.closeAllConnections?.()
      await new Promise((resolveClose) => httpServer.close(() => resolveClose()))
    },
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && resolve(fileURLToPath(import.meta.url)) === entry) {
  const port = Number(process.env.PORT || 8787)
  const certFile = process.env.TLS_CERT
  const keyFile = process.env.TLS_KEY
  const tls = certFile && keyFile
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : null
  start(port, { tls })
  const scheme = tls ? 'https' : 'http'
  console.log(`watch-room listening on ${scheme}://0.0.0.0:${port}`)
}
