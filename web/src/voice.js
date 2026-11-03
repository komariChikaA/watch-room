const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function candidatePayload(candidate) {
  if (!candidate) return null
  return candidate.toJSON ? candidate.toJSON() : candidate
}

export function createVoiceMesh(socket) {
  const peers = new Map()
  const audios = new Map()
  const early = []
  let localStream = null
  let sinkId = ''
  let volume = 1

  function setVolume(value) {
    volume = Math.min(1, Math.max(0, Number(value) || 0))
    for (const audio of audios.values()) {
      audio.volume = volume
      audio.muted = volume === 0
    }
  }

  async function useSink(audio) {
    if (!sinkId || typeof audio.setSinkId !== 'function') return
    await audio.setSinkId(sinkId)
  }

  async function setSink(id) {
    sinkId = id || ''
    await Promise.all([...audios.values()].map((audio) => useSink(audio).catch(() => {})))
  }

  function closeOne(id) {
    const entry = peers.get(id)
    if (entry) {
      entry.pc.close()
      peers.delete(id)
    }
    const audio = audios.get(id)
    if (audio) {
      audio.srcObject = null
      audio.remove()
      audios.delete(id)
    }
  }

  function stop() {
    for (const id of [...peers.keys()]) closeOne(id)
    localStream?.getTracks().forEach((track) => track.stop())
    localStream = null
  }

  async function start() {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    return localStream
  }

  function setMuted(muted) {
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
  }

  function attachRemote(id, event) {
    const stream = event.streams[0] || new MediaStream([event.track])
    let audio = audios.get(id)
    if (!audio) {
      audio = document.createElement('audio')
      audio.autoplay = true
      audio.dataset.voicePeer = id
      document.body.appendChild(audio)
      audios.set(id, audio)
    }
    audio.srcObject = stream
    audio.volume = volume
    audio.muted = volume === 0
    useSink(audio).finally(() => {
      audio.play().catch(() => {})
    })
  }

  function wire(pc, peerId, sessionId) {
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      socket.emit('voice-signal', {
        to: peerId,
        sessionId,
        candidate: candidatePayload(event.candidate),
      })
    }
    pc.ontrack = (event) => attachRemote(peerId, event)
  }

  async function offerTo(peerId) {
    if (!localStream || !peerId || peers.has(peerId)) return
    const sessionId = crypto.randomUUID()
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const entry = { pc, sessionId, pending: [], ready: false }
    peers.set(peerId, entry)
    try {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream)
      wire(pc, peerId, sessionId)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('voice-signal', { to: peerId, sessionId, description: pc.localDescription })
    } catch (error) {
      console.error(error)
      closeOne(peerId)
    }
  }

  async function handleSignal(message) {
    if (!localStream || !message?.from) return
    try {
      if (message.description?.type === 'offer') {
        closeOne(message.from)
        const sessionId = message.sessionId
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
        const entry = { pc, sessionId, pending: [], ready: false }
        peers.set(message.from, entry)
        for (const track of localStream.getTracks()) pc.addTrack(track, localStream)
        wire(pc, message.from, sessionId)
        await pc.setRemoteDescription(message.description)
        entry.ready = true
        const queued = entry.pending.splice(0)
        for (const candidate of queued) await pc.addIceCandidate(candidate)
        for (let index = early.length - 1; index >= 0; index -= 1) {
          const item = early[index]
          if (item.from !== message.from || item.sessionId !== sessionId) continue
          early.splice(index, 1)
          await pc.addIceCandidate(item.candidate)
        }
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('voice-signal', {
          to: message.from,
          sessionId,
          description: pc.localDescription,
        })
        return
      }

      const entry = peers.get(message.from)
      if (!entry || message.sessionId !== entry.sessionId) {
        if (message.candidate) {
          early.push(message)
          if (early.length > 40) early.shift()
        }
        return
      }
      if (message.description?.type === 'answer') {
        await entry.pc.setRemoteDescription(message.description)
        entry.ready = true
        const pending = entry.pending.splice(0)
        for (const candidate of pending) await entry.pc.addIceCandidate(candidate)
      }
      if (message.candidate) {
        if (!entry.ready) entry.pending.push(message.candidate)
        else await entry.pc.addIceCandidate(message.candidate)
      }
    } catch (error) {
      console.error(error)
    }
  }

  return { start, stop, setMuted, setVolume, setSink, offerTo, handleSignal, closeOne }
}
