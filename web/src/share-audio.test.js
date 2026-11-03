import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyShareAudioGate, shareAudioAllowed, voiceOutputIsolated } from './share-audio.js'

describe('share audio', () => {
  it('keeps system audio when this page is not in the voice channel', () => {
    assert.equal(shareAudioAllowed({ displaySurface: 'monitor', restrictOwnAudio: false, voiceOpen: false }), true)
    assert.equal(shareAudioAllowed({ displaySurface: 'browser', restrictOwnAudio: false, voiceOpen: false }), true)
  })

  it('keeps other apps when the browser can drop this page from system audio', () => {
    assert.equal(shareAudioAllowed({ displaySurface: 'monitor', restrictOwnAudio: true, voiceOpen: true }), true)
    assert.equal(shareAudioAllowed({ displaySurface: 'window', restrictOwnAudio: true, voiceOpen: true }), true)
  })

  it('drops share audio while voice is open if the mix would include it', () => {
    assert.equal(shareAudioAllowed({ displaySurface: 'monitor', restrictOwnAudio: false, voiceOpen: true }), false)
    assert.equal(shareAudioAllowed({ displaySurface: 'browser', restrictOwnAudio: true, voiceOpen: true }), false)
  })

  it('keeps share audio when voice plays on another device', () => {
    assert.equal(voiceOutputIsolated(''), false)
    assert.equal(voiceOutputIsolated('default'), false)
    assert.equal(voiceOutputIsolated('cable-1'), true)
    assert.equal(shareAudioAllowed({
      displaySurface: 'monitor',
      restrictOwnAudio: false,
      voiceOpen: true,
      voiceIsolated: true,
    }), true)
  })

  it('disables the captured audio track only while voice would leak into it', () => {
    const calls = []
    const audio = {
      enabled: true,
      getSettings: () => ({ restrictOwnAudio: false }),
    }
    const stream = {
      getVideoTracks: () => [{ getSettings: () => ({ displaySurface: 'monitor' }) }],
      getAudioTracks: () => [audio],
    }
    Object.defineProperty(audio, 'enabled', {
      get: () => audio._enabled,
      set: (value) => {
        audio._enabled = value
        calls.push(value)
      },
    })
    audio._enabled = true

    assert.deepEqual(applyShareAudioGate(stream, true), { allowed: false, held: true, reason: 'mixed' })
    assert.equal(audio.enabled, false)
    assert.deepEqual(applyShareAudioGate(stream, false), { allowed: true, held: false, reason: '' })
    assert.equal(audio.enabled, true)
    assert.deepEqual(calls, [false, true])
  })
})
