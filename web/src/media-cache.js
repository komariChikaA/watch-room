export const MEDIA_CACHE = 'watch-room-media-v1'

const MEDIA_PATH = /\.(mp4|webm|m4v|ogv|ogg|mov)$/i

export function mediaCacheKey(url, origin) {
  try {
    const parsed = new URL(url, origin)
    if (parsed.origin !== origin) return ''
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.pathname.startsWith('/uploads/')) return ''
    if (!MEDIA_PATH.test(parsed.pathname)) return ''
    return parsed.href
  } catch {
    return ''
  }
}

export function responseIsComplete(byteLength, contentLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return false
  if (contentLength == null || contentLength === '') return false
  const expected = Number(contentLength)
  if (!Number.isFinite(expected) || expected <= 0) return false
  return byteLength === expected
}

export async function cachedMediaSource(url, origin = window.location.origin) {
  const key = mediaCacheKey(url, origin)
  if (!key || typeof caches === 'undefined') return ''
  const cache = await caches.open(MEDIA_CACHE)
  const cached = await cache.match(key)
  if (!cached) return ''
  const blob = await cached.blob()
  if (!responseIsComplete(blob.size, cached.headers.get('content-length'))) {
    await cache.delete(key)
    return ''
  }
  return URL.createObjectURL(blob)
}
