export const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
}

export function isMediaPath(pathname) {
  const dot = String(pathname || '').lastIndexOf('.')
  if (dot < 0) return false
  return Object.hasOwn(MEDIA_TYPES, pathname.slice(dot).toLowerCase())
}

export function parseByteRange(header, size) {
  if (!Number.isInteger(size) || size < 0) return { error: 416 }
  if (header == null || header === '') return null
  if (!String(header).startsWith('bytes=')) return { error: 416 }
  const spec = String(header).slice('bytes='.length).split(',')[0].trim()
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (!match || (match[1] === '' && match[2] === '')) return { error: 416 }
  if (size === 0) return { error: 416 }

  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!Number.isInteger(suffix) || suffix <= 0) return { error: 416 }
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(match[1])
  if (!Number.isInteger(start) || start < 0 || start >= size) return { error: 416 }
  let end = size - 1
  if (match[2] !== '') {
    end = Number(match[2])
    if (!Number.isInteger(end) || end < start) return { error: 416 }
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

export function fileEtag(size, mtimeMs) {
  return `W/"${Number(size).toString(16)}-${Math.round(Number(mtimeMs)).toString(16)}"`
}

export function etagMatches(header, etag) {
  if (!header) return false
  return String(header)
    .split(',')
    .some((part) => {
      const value = part.trim()
      return value === '*' || value === etag
    })
}
