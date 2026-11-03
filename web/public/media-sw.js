const CACHE = 'watch-room-media-v1'
const MEDIA_PATH = /\.(mp4|webm|m4v|ogv|ogg|mov)$/i
const filling = new Map()

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/uploads/')) return
  if (!MEDIA_PATH.test(url.pathname)) return
  event.respondWith(serve(event, event.request))
})

function declaredSize(response) {
  const range = response.headers.get('content-range')
  const match = range && /\/(\d+)\s*$/.exec(range)
  if (match) return Number(match[1])
  if (response.status === 200) {
    const length = Number(response.headers.get('content-length'))
    return Number.isFinite(length) ? length : 0
  }
  return 0
}

function coversEntireFile(response) {
  const total = declaredSize(response)
  if (!total) return false
  if (response.status === 200) return true
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '')
  if (!match) return false
  return Number(match[1]) === 0 && Number(match[2]) + 1 === total && Number(match[3]) === total
}

function parseByteRange(header, size) {
  if (!header || !header.startsWith('bytes=') || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.split(',')[0].trim())
  if (!match || (match[1] === '' && match[2] === '')) return { error: 416 }
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!suffix) return { error: 416 }
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  if (start >= size) return { error: 416 }
  let end = size - 1
  if (match[2] !== '') {
    end = Number(match[2])
    if (end < start) return { error: 416 }
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

function sliceBlob(blob, type, rangeHeader) {
  const size = blob.size
  const contentType = type || 'video/mp4'
  if (!rangeHeader) {
    return new Response(blob, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(size),
        'accept-ranges': 'bytes',
      },
    })
  }
  const range = parseByteRange(rangeHeader, size)
  if (!range || range.error) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    })
  }
  const body = blob.slice(range.start, range.end + 1)
  return new Response(body, {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(body.size),
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'accept-ranges': 'bytes',
    },
  })
}

async function storeComplete(cache, key, response) {
  const total = declaredSize(response)
  const blob = await response.blob()
  if (!total || blob.size !== total) return
  await cache.put(
    key,
    new Response(blob, {
      headers: {
        'content-type': response.headers.get('content-type') || 'video/mp4',
        'content-length': String(blob.size),
      },
    }),
  )
}

function storeFromFullFetch(cache, key, url) {
  if (filling.has(url)) return filling.get(url)
  const job = fetch(new Request(url))
    .then((response) => {
      if (!coversEntireFile(response)) return null
      return storeComplete(cache, key, response)
    })
    .catch(() => null)
    .finally(() => filling.delete(url))
  filling.set(url, job)
  return job
}

async function serve(event, request) {
  const cache = await caches.open(CACHE)
  const key = new Request(request.url)
  const cached = await cache.match(key)
  if (cached) {
    const blob = await cached.blob()
    const expected = Number(cached.headers.get('content-length'))
    if (expected && blob.size === expected) {
      return sliceBlob(blob, cached.headers.get('content-type'), request.headers.get('range'))
    }
    await cache.delete(key)
  }

  const network = await fetch(request)
  if (coversEntireFile(network)) event.waitUntil(storeComplete(cache, key, network.clone()))
  else event.waitUntil(storeFromFullFetch(cache, key, request.url))
  return network
}
