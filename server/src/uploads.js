import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

const EXTENSIONS = {
  '.mp4': '.mp4',
  '.m4v': '.m4v',
  '.webm': '.webm',
  '.ogv': '.ogv',
  '.ogg': '.ogg',
  '.mov': '.mov',
}

const TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
}

export function uploadExtension(filename, contentType) {
  const fromName = EXTENSIONS[extname(String(filename || '')).toLowerCase()]
  if (fromName) return fromName
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  return TYPES[type] || ''
}

export function saveUpload(req, directory, extension, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve) => {
    const length = Number(req.headers['content-length'])
    if (!Number.isInteger(length) || length <= 0) {
      req.resume()
      resolve({ error: '没有收到影片' })
      return
    }
    if (length > maxBytes) {
      req.resume()
      resolve({ error: maxBytes >= 1024 ** 3 ? '影片太大了，最大 4GB' : '影片太大了' })
      return
    }

    const name = `${randomBytes(16).toString('hex')}${extension}`
    const full = join(directory, name)
    let received = 0
    let settled = false
    let file

    const finish = async (result) => {
      if (settled) return
      settled = true
      if (file) file.destroy()
      if (result.error) await rm(full, { force: true }).catch(() => {})
      resolve(result)
    }

    mkdir(directory, { recursive: true })
      .then(() => {
        if (settled) return
        file = createWriteStream(full)
        file.on('error', () => finish({ error: '影片没有保存下来' }))
        file.on('finish', () => {
          if (settled) return
          if (received !== length) {
            finish({ error: '影片没有传完整' })
            return
          }
          settled = true
          resolve({ ok: true, name, bytes: received })
        })
        req.on('data', (chunk) => {
          if (settled) return
          received += chunk.length
          if (received > length || received > maxBytes) {
            req.destroy()
            finish({ error: '影片没有传完整' })
            return
          }
          if (!file.write(chunk)) req.pause()
        })
        file.on('drain', () => {
          if (!settled) req.resume()
        })
        req.on('end', () => {
          if (!settled) file.end()
        })
        req.on('error', () => finish({ error: '影片没有传完整' }))
        req.on('aborted', () => finish({ error: '影片没有传完整' }))
      })
      .catch(() => finish({ error: '影片没有保存下来' }))
  })
}
