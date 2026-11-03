import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { playbackTime } from './playback.js'

describe('playback time', () => {
  it('stays on a paused position', () => {
    assert.equal(playbackTime({ playing: false, position: 12.5, updatedAt: 0 }, 10_000), 12.5)
  })

  it('keeps moving from the last update while playing', () => {
    assert.equal(playbackTime({ playing: true, position: 4, updatedAt: 1_000 }, 3_500), 6.5)
  })
})
