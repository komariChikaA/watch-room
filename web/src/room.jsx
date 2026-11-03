import { useEffect, useRef, useState } from 'react'
import { createHostPublisher, createViewerPlayer } from './rtc.js'
import { cachedMediaSource } from './media-cache.js'
import { playbackTime } from './playback.js'
import { applyShareAudioGate, voiceOutputIsolated } from './share-audio.js'
import { createVoiceMesh } from './voice.js'
import {
  entryKey,
  getSocket,
  hasEntry,
  lastRoomKey,
  nameKey,
  passwordKey,
  tokenKey,
} from './socket.js'

function formatTime(at) {
  const date = new Date(at)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

const DANMAKU_COLORS = ['#f6f0e6', '#f0d7a4', '#f0c2ae', '#d5e4c4', '#f3e7cf']

function readVolume(key) {
  const value = Number(localStorage.getItem(key))
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

function danmakuColor(name) {
  let hash = 0
  for (const char of String(name || '')) hash += char.charCodeAt(0)
  return DANMAKU_COLORS[hash % DANMAKU_COLORS.length]
}

async function captureScreen() {
  const video = { frameRate: { ideal: 24, max: 30 }, width: { ideal: 1280 }, height: { ideal: 720 } }
  const supported = navigator.mediaDevices.getSupportedConstraints?.() || {}
  const audio = supported.restrictOwnAudio ? { restrictOwnAudio: true } : true
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio })
  } catch (error) {
    if (error?.name === 'NotAllowedError') throw error
    if (audio !== true) {
      try {
        return await navigator.mediaDevices.getDisplayMedia({ video, audio: true })
      } catch (retry) {
        if (retry?.name === 'NotAllowedError') throw retry
      }
    }
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  }
}

export function Room({ code, navigate }) {
  const [gate, setGate] = useState(() => !hasEntry(code))
  const [name, setName] = useState(() => localStorage.getItem(nameKey) || '')
  const [password, setPassword] = useState(() => sessionStorage.getItem(passwordKey(code)) || '')
  const [error, setError] = useState('')
  const [state, setState] = useState(null)
  const [selfId, setSelfId] = useState('')
  const [remoteStream, setRemoteStream] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const [link, setLink] = useState('idle')
  const [filmVolume, setFilmVolume] = useState(() => readVolume('watch-room-film-volume'))
  const [voiceVolume, setVoiceVolume] = useState(() => readVolume('watch-room-voice-volume'))
  const [needTap, setNeedTap] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [danmakuOn, setDanmakuOn] = useState(() => localStorage.getItem('watch-room-danmaku') !== '0')
  const [flying, setFlying] = useState([])
  const [inVoice, setInVoice] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [shareAudioHeld, setShareAudioHeld] = useState(false)
  const [shareHoldReason, setShareHoldReason] = useState('')
  const [voiceSink, setVoiceSink] = useState(() => localStorage.getItem('watch-room-voice-sink') || '')
  const [voiceOutputs, setVoiceOutputs] = useState([])
  const [mediaSrc, setMediaSrc] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)

  const videoRef = useRef(null)
  const syncRef = useRef(null)
  const stageRef = useRef(null)
  const bottomRef = useRef(null)
  const streamRef = useRef(null)
  const publisherRef = useRef(null)
  const playerRef = useRef(null)
  const socketRef = useRef(null)
  const blockedRef = useRef(false)
  const stopSharingRef = useRef(() => {})
  const voiceRef = useRef(null)
  const anchorRef = useRef({ key: '', at: 0 })
  const mediaObjectUrl = useRef('')
  const resumedUrl = useRef('')
  const stateRef = useRef(null)
  const seenRef = useRef(null)
  const laneRef = useRef(0)
  const danmakuTimers = useRef(new Set())
  stateRef.current = state

  const hostToken = sessionStorage.getItem(tokenKey(code)) || ''
  const self = state?.members.find((member) => member.id === selfId)
  const isHost = self?.role === 'host'
  const stageStream = isHost ? localStream : remoteStream
  const insecureOrigin = window.isSecureContext === false

  stopSharingRef.current = () => {
    const stream = streamRef.current
    streamRef.current = null
    if (!stream) return
    for (const track of stream.getTracks()) track.stop()
    setLocalStream(null)
    setShareAudioHeld(false)
    setShareHoldReason('')
    publisherRef.current?.closeAll()
    socketRef.current?.emit('screening', { active: false })
  }

  useEffect(() => {
    document.title = state?.title ? `${state.title} · 放映室` : '放映室'
    return () => {
      document.title = '放映室'
    }
  }, [state?.title])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state?.messages.length])

  useEffect(() => () => {
    for (const timer of danmakuTimers.current) window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const messages = state?.messages
    if (!messages) return
    if (!seenRef.current) {
      seenRef.current = new Set(messages.map((message) => message.id))
      return
    }
    const fresh = []
    for (const message of messages) {
      if (seenRef.current.has(message.id)) continue
      seenRef.current.add(message.id)
      if (!message.system && message.text) fresh.push(message)
    }
    if (!fresh.length || !danmakuOn) return
    const items = fresh.map((message) => {
      const lane = laneRef.current % 6
      laneRef.current += 1
      return {
        id: message.id,
        text: message.text,
        name: message.name,
        lane,
        color: danmakuColor(message.name),
      }
    })
    setFlying((current) => [...current, ...items])
    for (const item of items) {
      const timer = window.setTimeout(() => {
        danmakuTimers.current.delete(timer)
        setFlying((current) => current.filter((entry) => entry.id !== item.id))
      }, 9000)
      danmakuTimers.current.add(timer)
    }
  }, [danmakuOn, state?.messages])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    video.srcObject = stageStream
    if (!stageStream) return undefined
    video.muted = isHost || filmVolume === 0
    if (!isHost) video.volume = filmVolume
    const pending = video.play()
    if (pending) {
      pending.then(() => setNeedTap(false)).catch(() => {
        if (!isHost) setNeedTap(true)
      })
    }
    return undefined
  }, [stageStream, filmVolume, isHost])

  useEffect(() => {
    const video = syncRef.current
    const playback = state?.playback
    if (!video || !playback || isHost) return undefined
    const key = `${playback.url}|${playback.playing}|${playback.position}|${playback.updatedAt}`
    if (anchorRef.current.key !== key) anchorRef.current = { key, at: playback.updatedAt }
    let cancelled = false

    const expectedTime = () => (
      playback.playing
        ? playback.position + (Date.now() - anchorRef.current.at) / 1000
        : playback.position
    )

    const apply = async () => {
      if (cancelled) return
      const expected = expectedTime()
      if (Number.isFinite(video.duration) && expected > video.duration) return
      if (Math.abs((video.currentTime || 0) - expected) > 0.75) {
        video.currentTime = expected
      }
      video.volume = filmVolume
      video.muted = filmVolume === 0
      if (playback.playing) {
        try {
          await video.play()
          if (!cancelled) setNeedTap(false)
        } catch {
          if (!cancelled) setNeedTap(true)
        }
      } else {
        video.pause()
      }
    }

    if (video.readyState < 1) video.addEventListener('loadedmetadata', apply, { once: true })
    else apply()
    const timer = setInterval(() => {
      if (cancelled || !playback.playing || video.readyState < 1) return
      const expected = expectedTime()
      if (Math.abs(video.currentTime - expected) > 1.2) video.currentTime = expected
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
      video.removeEventListener('loadedmetadata', apply)
    }
  }, [filmVolume, isHost, mediaSrc, state?.playback, stageStream])

  useEffect(() => {
    const sync = syncRef.current
    if (!sync) return
    sync.volume = filmVolume
    sync.muted = filmVolume === 0
    voiceRef.current?.setVolume(voiceVolume)
  }, [filmVolume, voiceVolume, mediaSrc])

  useEffect(() => {
    const url = state?.playback?.url
    if (!url) {
      if (mediaObjectUrl.current) URL.revokeObjectURL(mediaObjectUrl.current)
      mediaObjectUrl.current = ''
      resumedUrl.current = ''
      setMediaSrc('')
      return undefined
    }
    let cancelled = false
    cachedMediaSource(url)
      .then((objectUrl) => {
        if (cancelled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          return
        }
        if (mediaObjectUrl.current && mediaObjectUrl.current !== objectUrl) {
          URL.revokeObjectURL(mediaObjectUrl.current)
        }
        mediaObjectUrl.current = objectUrl || ''
        setMediaSrc(objectUrl || url)
      })
      .catch(() => {
        if (!cancelled) setMediaSrc(url)
      })
    return () => {
      cancelled = true
    }
  }, [state?.playback?.url])

  useEffect(() => {
    const video = syncRef.current
    const playback = state?.playback
    if (!video || !isHost || !playback || !mediaSrc) return undefined
    if (resumedUrl.current === playback.url) {
      const send = () => {
        socketRef.current?.emit('playback', {
          playing: !video.paused && !video.ended,
          position: video.currentTime || 0,
        })
      }
      video.addEventListener('play', send)
      video.addEventListener('pause', send)
      video.addEventListener('seeked', send)
      return () => {
        video.removeEventListener('play', send)
        video.removeEventListener('pause', send)
        video.removeEventListener('seeked', send)
      }
    }

    let hold = true
    const target = playbackTime(playback)
    const send = () => {
      if (hold) return
      socketRef.current?.emit('playback', {
        playing: !video.paused && !video.ended,
        position: video.currentTime || 0,
      })
    }
    const apply = () => {
      const duration = video.duration
      const clamped = Number.isFinite(duration) && duration > 0.05
        ? Math.min(target, Math.max(0, duration - 0.05))
        : target
      if (Math.abs((video.currentTime || 0) - clamped) > 0.3) video.currentTime = clamped
      resumedUrl.current = playback.url
      if (playback.playing) {
        video.play().then(() => {
          hold = false
        }).catch(() => {
          hold = false
          setNeedTap(true)
          socketRef.current?.emit('playback', { playing: false, position: video.currentTime || 0 })
        })
        return
      }
      video.pause()
      hold = false
    }

    if (video.readyState < 1) video.addEventListener('loadedmetadata', apply, { once: true })
    else apply()
    video.addEventListener('play', send)
    video.addEventListener('pause', send)
    video.addEventListener('seeked', send)
    return () => {
      hold = true
      video.removeEventListener('loadedmetadata', apply)
      video.removeEventListener('play', send)
      video.removeEventListener('pause', send)
      video.removeEventListener('seeked', send)
    }
  }, [isHost, mediaSrc, state?.playback?.url])

  useEffect(() => {
    if (gate) return undefined
    const socket = getSocket()
    socketRef.current = socket
    blockedRef.current = false
    socket.io.reconnection(true)
    const publisher = createHostPublisher(socket)
    const player = createViewerPlayer(socket, {
      onStream(stream) {
        setRemoteStream(stream)
        if (stream) setLink('live')
      },
      onState(connectionState) {
        if (connectionState === 'connected') setLink('live')
        else if (connectionState === 'failed') setLink('failed')
        else if (connectionState === 'connecting' || connectionState === 'checking') setLink('connecting')
      },
    })
    publisherRef.current = publisher
    playerRef.current = player

    let alive = true

    function enter() {
      if (!alive || blockedRef.current) return
      voiceRef.current?.stop()
      voiceRef.current = null
      setInVoice(false)
      setMicMuted(false)
      applyShareAudioGate(streamRef.current, false)
      setShareAudioHeld(false)
      setShareHoldReason('')
      publisher.closeAll()
      player.close()
      setRemoteStream(null)
      const payload = {
        roomId: code,
        name: localStorage.getItem(nameKey) || '',
        password: sessionStorage.getItem(passwordKey(code)) || '',
        hostToken: sessionStorage.getItem(tokenKey(code)) || '',
      }
      socket.emit('join-room', payload, (result) => {
        if (!alive) return
        if (result?.error) {
          setError(result.error)
          setState(null)
          setGate(true)
          sessionStorage.removeItem(entryKey(code))
          return
        }
        setSelfId(result.selfId || socket.id)
        setState(result.state)
        setError('')
        setLink(result.state?.screening ? 'connecting' : 'idle')
      })
    }

    function onRoomState(next) {
      setState(next)
      const me = next.members.find((member) => member.id === socket.id)
      if (me && me.role !== 'host') stopSharingRef.current()
      if (!next.screening) {
        player.close()
        setRemoteStream(null)
        setLink('idle')
      } else if (me?.role !== 'host') {
        setLink((current) => (current === 'live' ? current : 'connecting'))
      }
    }

    function onPeerJoined({ id }) {
      if (streamRef.current) publisher.offerTo(id, streamRef.current)
    }

    function onPeerLeft({ id }) {
      publisher.closeOne(id)
    }

    function onSignal(message) {
      if (publisher.has(message.from)) publisher.handleSignal(message)
      else player.handleSignal(message)
    }

    function onVoiceSignal(message) {
      voiceRef.current?.handleSignal(message)
    }

    function onVoiceLeft({ id }) {
      voiceRef.current?.closeOne(id)
    }

    function onKicked(payload) {
      blockedRef.current = true
      sessionStorage.removeItem(entryKey(code))
      sessionStorage.removeItem(tokenKey(code))
      sessionStorage.removeItem(passwordKey(code))
      socket.io.reconnection(false)
      socket.disconnect()
      stopSharingRef.current()
      voiceRef.current?.stop()
      voiceRef.current = null
      setInVoice(false)
      setState(null)
      setError(payload?.message || '主持人已将你移出放映室')
      setGate(true)
    }

    function onConnectError() {
      setError('连不上放映室服务器')
    }

    socket.on('room-state', onRoomState)
    socket.on('peer-joined', onPeerJoined)
    socket.on('peer-left', onPeerLeft)
    socket.on('signal', onSignal)
    socket.on('voice-signal', onVoiceSignal)
    socket.on('voice-left', onVoiceLeft)
    socket.on('kicked', onKicked)
    socket.on('connect_error', onConnectError)
    socket.on('connect', enter)
    if (socket.connected) enter()
    else socket.connect()

    return () => {
      alive = false
      socket.off('room-state', onRoomState)
      socket.off('peer-joined', onPeerJoined)
      socket.off('peer-left', onPeerLeft)
      socket.off('signal', onSignal)
      socket.off('voice-signal', onVoiceSignal)
      socket.off('voice-left', onVoiceLeft)
      socket.off('kicked', onKicked)
      socket.off('connect_error', onConnectError)
      socket.off('connect', enter)
      publisher.closeAll()
      player.close()
      const stream = streamRef.current
      streamRef.current = null
      if (stream) {
        for (const track of stream.getTracks()) track.stop()
      }
      setLocalStream(null)
      voiceRef.current?.stop()
      voiceRef.current = null
      if (!blockedRef.current && socket.connected) socket.emit('leave-room')
    }
  }, [gate, code])

  async function startSharing() {
    const socket = socketRef.current
    if (!socket) return
    setBusy(true)
    setError('')
    try {
      const stream = await captureScreen()
      streamRef.current = stream
      setLocalStream(stream)
      syncShareAudio(Boolean(voiceRef.current))
      for (const track of stream.getTracks()) {
        track.onended = () => stopSharingRef.current()
      }
      socket.emit('screening', { active: true }, (result) => {
        if (result?.error) {
          setError(result.error)
          stopSharingRef.current()
          return
        }
        if (result?.state) setState(result.state)
        if (stateRef.current?.playback) socket.emit('playback', { clear: true })
        const viewers = (result?.state?.members || []).filter((member) => member.role !== 'host')
        for (const viewer of viewers) publisherRef.current?.offerTo(viewer.id, stream)
      })
    } catch (error) {
      if (error?.name !== 'NotAllowedError') setError('没能开始放映，请再试一次')
    } finally {
      setBusy(false)
    }
  }

  function submitGate(event) {
    event.preventDefault()
    const nextName = name.trim()
    if (!nextName) {
      setError('请填写名字')
      return
    }
    localStorage.setItem(nameKey, nextName)
    sessionStorage.setItem(passwordKey(code), password)
    sessionStorage.setItem(entryKey(code), '1')
    sessionStorage.setItem(lastRoomKey, code)
    blockedRef.current = false
    setError('')
    setGate(false)
  }

  function exitRoom() {
    sessionStorage.removeItem(entryKey(code))
    navigate('/')
  }

  async function copyLink() {
    const url = `${window.location.origin}/r/${code}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('复制失败，请手动复制地址栏里的链接')
    }
  }

  function toggleDanmaku() {
    setDanmakuOn((current) => {
      const next = !current
      localStorage.setItem('watch-room-danmaku', next ? '1' : '0')
      if (!next) setFlying([])
      return next
    })
  }

  function syncShareAudio(voiceOpen, sinkId = voiceSink) {
    const gate = applyShareAudioGate(streamRef.current, voiceOpen, {
      voiceIsolated: voiceOutputIsolated(sinkId),
    })
    setShareAudioHeld(gate.held)
    setShareHoldReason(gate.reason)
    return gate
  }

  async function refreshVoiceOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    setVoiceOutputs(devices.filter((device) => (
      device.kind === 'audiooutput'
      && device.deviceId
      && device.deviceId !== 'default'
      && device.deviceId !== 'communications'
    )))
  }

  async function changeVoiceSink(event) {
    const sinkId = event.target.value
    localStorage.setItem('watch-room-voice-sink', sinkId)
    setVoiceSink(sinkId)
    try {
      await voiceRef.current?.setSink(sinkId)
    } catch {
      setError('这个设备播不了语音')
    }
    syncShareAudio(Boolean(voiceRef.current), sinkId)
  }

  async function toggleVoice() {
    const socket = socketRef.current
    if (!socket) return
    if (inVoice) {
      voiceRef.current?.stop()
      voiceRef.current = null
      setInVoice(false)
      setMicMuted(false)
      syncShareAudio(false)
      socket.emit('voice-leave')
      return
    }
    const voice = createVoiceMesh(socket)
    try {
      await voice.start()
    } catch (error) {
      if (error?.name !== 'NotAllowedError') setError('没能打开麦克风')
      return
    }
    voiceRef.current = voice
    voice.setVolume(voiceVolume)
    socket.emit('voice-join', {}, async (result) => {
      if (result?.error) {
        voice.stop()
        voiceRef.current = null
        syncShareAudio(false)
        setError(result.error)
        return
      }
      setInVoice(true)
      setMicMuted(false)
      await voice.setSink(voiceSink)
      await refreshVoiceOutputs()
      syncShareAudio(true)
      if (result.state) setState(result.state)
      for (const peerId of result.peers || []) voice.offerTo(peerId)
    })
  }

  function toggleMic() {
    const next = !micMuted
    voiceRef.current?.setMuted(next)
    setMicMuted(next)
    socketRef.current?.emit('voice-mute', { muted: next })
  }

  function sendChat(event) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    socketRef.current?.emit('chat', { text }, (result) => {
      if (result?.error) setError(result.error)
    })
    setDraft('')
  }

  function kick(member) {
    if (!window.confirm(`把 ${member.name} 移出放映室？对方还可以用密码再进来。`)) return
    socketRef.current?.emit('kick', { targetId: member.id }, (result) => {
      if (result?.error) setError(result.error)
    })
  }

  function loadSync(event) {
    event.preventDefault()
    const url = mediaUrl.trim()
    if (!url) {
      setError('请填写视频地址')
      return
    }
    if (streamRef.current) stopSharingRef.current()
    socketRef.current?.emit('playback', { url }, (result) => {
      if (result?.error) setError(result.error)
      else setMediaError('')
    })
  }

  function uploadVideo(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || uploading) return
    if (!/\.(mp4|m4v|webm|ogv|ogg|mov)$/i.test(file.name)) {
      setError('请上传 mp4、webm 或 mov')
      return
    }
    if (file.size > 4 * 1024 * 1024 * 1024) {
      setError('影片太大了，最大 4GB')
      return
    }
    const token = sessionStorage.getItem(tokenKey(code)) || ''
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/rooms/${code}/video`)
    xhr.setRequestHeader('x-host-token', token)
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name))
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (progress) => {
      if (!progress.lengthComputable) return
      setUploadPercent(Math.round((progress.loaded / progress.total) * 100))
    }
    xhr.onload = () => {
      setUploading(false)
      let body = {}
      try {
        body = JSON.parse(xhr.responseText || '{}')
      } catch {
        body = {}
      }
      if (xhr.status < 200 || xhr.status >= 300 || !body.url) {
        setError(body.error || '上传失败')
        return
      }
      if (streamRef.current) stopSharingRef.current()
      socketRef.current?.emit('playback', { url: body.url }, (result) => {
        if (result?.error) setError(result.error)
        else setMediaError('')
      })
    }
    xhr.onerror = () => {
      setUploading(false)
      setError('上传失败')
    }
    setUploading(true)
    setUploadPercent(0)
    setError('')
    xhr.send(file)
  }

  function playSample() {
    if (streamRef.current) stopSharingRef.current()
    socketRef.current?.emit('playback', { url: '/sample.mp4' }, (result) => {
      if (result?.error) setError(result.error)
      else setMediaError('')
    })
  }

  function clearSync() {
    socketRef.current?.emit('playback', { clear: true }, (result) => {
      if (result?.error) setError(result.error)
    })
  }

  function unlockPlayback() {
    const video = syncRef.current || videoRef.current
    if (!video) return
    const stage = video === videoRef.current
    video.muted = (stage && isHost) || filmVolume === 0
    if (!(stage && isHost)) video.volume = filmVolume
    video.play().then(() => setNeedTap(false)).catch(() => setNeedTap(true))
  }

  async function toggleFullscreen() {
    const stage = stageRef.current
    if (!stage) return
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    await stage.requestFullscreen()
  }

  if (gate) {
    return (
      <main className="lobby">
        <form className="lobby-card" onSubmit={submitGate}>
          <p className="eyebrow">房间 {code}</p>
          <h1>进入放映室</h1>
          <p className="lede">{hostToken ? '这台浏览器里还留着主持人身份。' : '向主持人要密码。没有密码的房间，留空即可。'}</p>
          <label>
            你的名字
            <input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} />
          </label>
          {hostToken ? null : (
            <label>
              房间密码
              <input value={password} maxLength={64} autoComplete="off" onChange={(event) => setPassword(event.target.value)} />
            </label>
          )}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary" type="submit">
            进入
          </button>
          <button className="text-button" type="button" onClick={() => navigate('/')}>
            回到大厅
          </button>
        </form>
      </main>
    )
  }

  if (!state) {
    return (
      <main className="lobby">
        <div className="lobby-card">
          <p className="eyebrow">房间 {code}</p>
          <h1>正在进入…</h1>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : (
            <p className="lede">正在连接放映室。</p>
          )}
        </div>
      </main>
    )
  }

  const showSync = Boolean(state.playback?.url) && !stageStream
  const statusText = state.hostAway
    ? '主持人暂时离开'
    : showSync
      ? state.playback.playing
        ? '正在同步播放'
        : '同步播放已暂停'
      : state.screening
        ? isHost
          ? localStream
            ? '正在放映'
            : '等待本机画面'
          : link === 'live'
            ? '正在观看'
            : link === 'failed'
              ? '画面没有连上'
              : '正在连接画面'
        : '还没开始放映'

  return (
    <main className={`room ${panelOpen ? 'panel-open' : ''}`}>
      <header className="topbar">
        <div className="title-block">
          <p className="eyebrow">放映室</p>
          <h1>{state.title}</h1>
        </div>
        <div className="top-meta">
          <span className={`pill ${state.screening || state.playback?.playing ? 'live' : ''}`}>{statusText}</span>
          <span className="pill">{state.members.length} 人</span>
          <button type="button" onClick={copyLink}>
            {copied ? '已复制链接' : code}
          </button>
          <button className="panel-toggle" type="button" onClick={() => setPanelOpen((open) => !open)}>
            {panelOpen ? '回到画面' : '聊天'}
          </button>
          <button type="button" onClick={exitRoom}>
            离开
          </button>
        </div>
      </header>

      {error ? (
        <p className="banner" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>
            知道了
          </button>
        </p>
      ) : null}

      <div className="room-body">
        <section className="stage" ref={stageRef}>
          <div className="screen">
            {showSync ? (
              mediaSrc ? (
                <video
                  ref={syncRef}
                  src={mediaSrc}
                  controls={isHost}
                  playsInline
                  preload="auto"
                  onError={() => setMediaError('这个地址打不开。需要是浏览器能直接播放的 mp4 或 webm。')}
                  onLoadedData={() => setMediaError('')}
                />
              ) : (
                <div className="overlay">
                  <p>正在打开影片…</p>
                </div>
              )
            ) : (
              <video ref={videoRef} autoPlay playsInline muted={isHost || filmVolume === 0} />
            )}
            {showSync && mediaError ? (
              <div className="overlay">
                <p>{mediaError}</p>
              </div>
            ) : null}
            {!showSync && !stageStream ? (
              <div className="overlay">
                <p>{statusText}</p>
                {isHost ? <p className="fine">可以分享屏幕，也可以让大家同步播放同一个视频地址。</p> : null}
                {!isHost && link === 'failed' ? (
                  <p className="fine">两个人之间没有接通。同一局域网通常可以直接看；隔着复杂网络时，需要后面再加的中继服务。</p>
                ) : null}
              </div>
            ) : null}
            {needTap && (showSync || stageStream) ? (
              <button className="tap" type="button" onClick={unlockPlayback}>
                点击开始播放
              </button>
            ) : null}
            {danmakuOn && flying.length ? (
              <div className="danmaku-layer" aria-hidden="true">
                {flying.map((item) => (
                  <span
                    key={item.id}
                    className="danmaku-item"
                    style={{ top: `${8 + item.lane * 12}%`, color: item.color }}
                  >
                    <b>{item.name}</b>
                    {item.text}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="dock">
            {isHost ? (
              localStream ? (
                <button className="primary" type="button" onClick={() => stopSharingRef.current()}>
                  停止放映
                </button>
              ) : (
                <button className="primary" type="button" disabled={busy} onClick={startSharing}>
                  {busy ? '正在准备…' : '分享屏幕'}
                </button>
              )
            ) : (
              <span className="fine">
                {showSync ? '进度跟着主持人' : state.screening ? '主持人正在放映' : '等主持人开始'}
              </span>
            )}
            <label className="volume">
              影片
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(filmVolume * 100)}
                aria-label="影片音量"
                onChange={(event) => {
                  const next = Number(event.target.value) / 100
                  localStorage.setItem('watch-room-film-volume', String(next))
                  setFilmVolume(next)
                }}
              />
            </label>
            <label className="volume">
              语音
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(voiceVolume * 100)}
                aria-label="语音音量"
                onChange={(event) => {
                  const next = Number(event.target.value) / 100
                  localStorage.setItem('watch-room-voice-volume', String(next))
                  setVoiceVolume(next)
                  voiceRef.current?.setVolume(next)
                }}
              />
            </label>
            <button type="button" onClick={toggleVoice}>
              {inVoice ? '离开语音' : '加入语音'}
            </button>
            {inVoice ? (
              <button type="button" onClick={toggleMic} aria-pressed={!micMuted}>
                {micMuted ? '麦克风关' : '麦克风开'}
              </button>
            ) : null}
            {inVoice ? (
              <label className="voice-sink">
                语音播放到
                <select value={voiceSink} onChange={changeVoiceSink}>
                  <option value="">当前扬声器</option>
                  {voiceOutputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || '音频设备'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="button" onClick={toggleDanmaku} aria-pressed={danmakuOn}>
              {danmakuOn ? '弹幕开' : '弹幕关'}
            </button>
            <button type="button" onClick={toggleFullscreen}>
              全屏
            </button>
            {isHost ? (
              <form className="sync-form" onSubmit={loadSync}>
                <input
                  value={mediaUrl}
                  placeholder="视频地址，例如 https://…/film.mp4"
                  onChange={(event) => setMediaUrl(event.target.value)}
                />
                <button type="submit">同步这个地址</button>
                <label className={`file-button ${uploading ? 'disabled' : ''}`}>
                  {uploading ? `正在上传 ${uploadPercent}%` : '上传影片'}
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/ogg,video/quicktime,.mp4,.webm,.m4v,.ogv,.ogg,.mov"
                    disabled={uploading}
                    onChange={uploadVideo}
                  />
                </label>
                <button type="button" onClick={playSample}>
                  播放示例
                </button>
                {state.playback ? (
                  <button type="button" onClick={clearSync}>
                    结束同步
                  </button>
                ) : null}
              </form>
            ) : null}
          </div>
          {shareAudioHeld && shareHoldReason === 'tab' ? (
            <p className="fine dock-note">分享的是这个标签页，语音会混进页面声音。请改分享整个屏幕或窗口，并勾选系统音频。</p>
          ) : null}
          {shareAudioHeld && shareHoldReason === 'mixed' ? (
            <p className="fine dock-note">语音和影片走同一个扬声器时，共享带不上影片声音。把「语音播放到」改成耳机或虚拟声卡，影片留在原来的扬声器。</p>
          ) : null}
          {insecureOrigin && isHost ? (
            <p className="fine dock-note">
              现在是普通 http，浏览器不允许截取屏幕和开麦克风。请改用 https 地址，或在这台电脑上打开 localhost。
            </p>
          ) : null}
        </section>

        <aside className="aside">
          <div className="roster">
            <h2>在场</h2>
            <ul>
              {state.members.map((member) => (
                <li key={member.id}>
                  <span>
                    {member.name}
                    {member.role === 'host' ? <em>主持人</em> : null}
                    {member.voice ? <em>{member.muted ? '已静音' : '语音'}</em> : null}
                  </span>
                  {isHost && member.id !== selfId ? (
                    <button type="button" onClick={() => kick(member)}>
                      移出
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="chat">
            <h2>聊天</h2>
            <div className="messages">
              {state.messages.length === 0 ? <p className="fine">说点什么，或者安静看完这一段。</p> : null}
              {state.messages.map((message) => (
                <p key={message.id} className={message.system ? 'system' : 'line'}>
                  {message.system ? (
                    <span>{message.text}</span>
                  ) : (
                    <>
                      <strong>{message.name}</strong>
                      <span>{message.text}</span>
                    </>
                  )}
                  <time>{formatTime(message.at)}</time>
                </p>
              ))}
              <div ref={bottomRef} />
            </div>
            <form className="composer" onSubmit={sendChat}>
              <input
                value={draft}
                maxLength={500}
                placeholder="写给房间里的人"
                onChange={(event) => setDraft(event.target.value)}
              />
              <button className="primary" type="submit">
                发送
              </button>
            </form>
          </div>
        </aside>
      </div>
    </main>
  )
}
