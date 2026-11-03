const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function candidatePayload(candidate) {
  if (!candidate) return null
  return candidate.toJSON ? candidate.toJSON() : candidate
}

export function createHostPublisher(socket) {
  const peers = new Map()

  async function offerTo(viewerId, stream) {
    if (!viewerId || !stream) return
    const existing = peers.get(viewerId)
    if (existing) {
      const state = existing.pc.connectionState
      if (state !== 'failed' && state !== 'disconnected' && state !== 'closed') return
      closeOne(viewerId)
    }
    const sessionId = crypto.randomUUID()
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const entry = { pc, sessionId, pending: [], ready: false }
    peers.set(viewerId, entry)

    try {
      for (const track of stream.getTracks()) pc.addTrack(track, stream)
      pc.onicecandidate = (event) => {
        if (!event.candidate) return
        socket.emit('signal', {
          to: viewerId,
          sessionId,
          candidate: candidatePayload(event.candidate),
        })
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('signal', {
        to: viewerId,
        sessionId,
        description: pc.localDescription,
      })
    } catch (error) {
      console.error(error)
      pc.close()
      peers.delete(viewerId)
    }
  }

  async function handleSignal(message) {
    const entry = peers.get(message.from)
    if (!entry || message.sessionId !== entry.sessionId) return
    try {
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

  function closeOne(id) {
    const entry = peers.get(id)
    if (!entry) return
    entry.pc.close()
    peers.delete(id)
  }

  function closeAll() {
    for (const id of [...peers.keys()]) closeOne(id)
  }

  return {
    offerTo,
    handleSignal,
    closeOne,
    closeAll,
    has(id) {
      return peers.has(id)
    },
  }
}

export function createViewerPlayer(socket, { onStream, onState }) {
  let pc = null
  let sessionId = ''
  let pending = []
  let ready = false
  let generation = 0
  const early = []

  function close() {
    generation += 1
    if (pc) {
      pc.close()
      onStream(null)
    }
    pc = null
    sessionId = ''
    pending = []
    ready = false
  }

  async function handleSignal(message) {
    try {
      if (message.description?.type === 'offer') {
        close()
        const ticket = generation
        sessionId = message.sessionId
        const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS })
        pc = connection
        connection.ontrack = (event) => {
          if (ticket !== generation) return
          onStream(event.streams[0] || new MediaStream([event.track]))
        }
        connection.onconnectionstatechange = () => {
          if (ticket !== generation) return
          onState(connection.connectionState)
        }
        connection.onicecandidate = (event) => {
          if (!event.candidate || ticket !== generation) return
          socket.emit('signal', {
            to: message.from,
            sessionId,
            candidate: candidatePayload(event.candidate),
          })
        }
        onState('connecting')
        await connection.setRemoteDescription(message.description)
        if (ticket !== generation) return
        ready = true
        const queued = pending.splice(0)
        for (const candidate of queued) await connection.addIceCandidate(candidate)
        for (let index = early.length - 1; index >= 0; index -= 1) {
          if (early[index].sessionId !== sessionId) continue
          const [item] = early.splice(index, 1)
          await connection.addIceCandidate(item.candidate)
        }
        if (ticket !== generation) return
        const answer = await connection.createAnswer()
        if (ticket !== generation) return
        await connection.setLocalDescription(answer)
        if (ticket !== generation) return
        socket.emit('signal', {
          to: message.from,
          sessionId,
          description: connection.localDescription,
        })
      }

      if (message.candidate) {
        if (!pc || message.sessionId !== sessionId || !ready) {
          if (!pc || message.sessionId !== sessionId) {
            early.push(message)
            if (early.length > 40) early.shift()
            return
          }
          pending.push(message.candidate)
          return
        }
        await pc.addIceCandidate(message.candidate)
      }
    } catch (error) {
      console.error(error)
      onState('failed')
    }
  }

  return { handleSignal, close }
}
