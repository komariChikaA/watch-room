export function playbackTime(playback, now = Date.now()) {
  if (!playback) return 0
  const position = Number(playback.position)
  const safe = Number.isFinite(position) && position > 0 ? position : 0
  if (!playback.playing) return safe
  const updatedAt = Number(playback.updatedAt)
  const anchor = Number.isFinite(updatedAt) ? updatedAt : now
  return safe + Math.max(0, (now - anchor) / 1000)
}
