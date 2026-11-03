import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mediaCacheKey, responseIsComplete } from './media-cache.js'

describe('media cache', () => {
  it('caches only same-origin video files', () => {
    const origin = 'http://127.0.0.1:5173'
    assert.equal(mediaCacheKey('/sample.mp4', origin), 'http://127.0.0.1:5173/sample.mp4')
    assert.equal(mediaCacheKey('/uploads/abc.mp4', origin), '')
    assert.equal(mediaCacheKey('https://cdn.example/film.mp4', origin), '')
    assert.equal(mediaCacheKey('/clip.txt', origin), '')
  })

  it('accepts a body only when it matches the declared length', () => {
    assert.equal(responseIsComplete(120, '120'), true)
    assert.equal(responseIsComplete(80, '120'), false)
    assert.equal(responseIsComplete(120, ''), false)
    assert.equal(responseIsComplete(0, '0'), false)
  })
})
