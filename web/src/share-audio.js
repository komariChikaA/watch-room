export function voiceOutputIsolated(sinkId) {
  return Boolean(sinkId) && sinkId !== 'default' && sinkId !== 'communications'
}

export function shareAudioAllowed({ displaySurface, restrictOwnAudio, voiceOpen, voiceIsolated }) {
  if (!voiceOpen) return true
  if (displaySurface === 'browser') return false
  if (restrictOwnAudio) return true
  return Boolean(voiceIsolated)
}

export function applyShareAudioGate(stream, voiceOpen, options = {}) {
  if (!stream) return { allowed: true, held: false, reason: '' }
  const video = stream.getVideoTracks()[0]
  const audio = stream.getAudioTracks()[0]
  const surface = video?.getSettings?.().displaySurface
  const allowed =
    !audio ||
    shareAudioAllowed({
      displaySurface: surface,
      restrictOwnAudio: audio.getSettings?.().restrictOwnAudio === true,
      voiceOpen: Boolean(voiceOpen),
      voiceIsolated: Boolean(options.voiceIsolated),
    })
  for (const track of stream.getAudioTracks()) track.enabled = allowed
  const held = Boolean(audio) && !allowed
  let reason = ''
  if (held) reason = surface === 'browser' ? 'tab' : 'mixed'
  return { allowed, held, reason }
}
