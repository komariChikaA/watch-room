import { useEffect, useState } from 'react'
import { entryKey, lastRoomKey, nameKey, passwordKey, tokenKey } from './socket.js'

export function Lobby({ navigate }) {
  const [mode, setMode] = useState('create')
  const [name, setName] = useState(() => localStorage.getItem(nameKey) || '')
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const lastRoom = sessionStorage.getItem(lastRoomKey) || ''

  useEffect(() => {
    document.title = '放映室'
  }, [])

  function remember(nextName) {
    localStorage.setItem(nameKey, nextName)
  }

  async function createRoom(event) {
    event.preventDefault()
    const nextName = name.trim()
    if (!nextName) {
      setError('请填写名字')
      return
    }
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nextName, title, password }),
      })
      const result = await response.json()
      if (!response.ok) {
        setError(result.error || '创建失败')
        return
      }
      remember(nextName)
      sessionStorage.setItem(tokenKey(result.roomId), result.hostToken)
      sessionStorage.setItem(passwordKey(result.roomId), password)
      sessionStorage.setItem(entryKey(result.roomId), '1')
      sessionStorage.setItem(lastRoomKey, result.roomId)
      navigate(`/r/${result.roomId}`)
    } catch {
      setError('连不上放映室服务器')
    } finally {
      setPending(false)
    }
  }

  function joinRoom(event) {
    event.preventDefault()
    const nextName = name.trim()
    const code = roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!nextName) {
      setError('请填写名字')
      return
    }
    if (code.length < 4) {
      setError('房间号看起来不完整')
      return
    }
    remember(nextName)
    sessionStorage.removeItem(tokenKey(code))
    sessionStorage.setItem(passwordKey(code), password)
    sessionStorage.setItem(entryKey(code), '1')
    sessionStorage.setItem(lastRoomKey, code)
    navigate(`/r/${code}`)
  }

  return (
    <main className="lobby">
      <div className="lobby-card">
        <p className="eyebrow">Watch Room</p>
        <h1>放映室</h1>
        <p className="lede">一个人放映，朋友们打开链接就能看。适合小范围一起看电影、演示或者玩游戏。</p>

        <div className="segment" role="tablist" aria-label="进入方式">
          <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>
            创建
          </button>
          <button type="button" role="tab" aria-selected={mode === 'join'} onClick={() => setMode('join')}>
            加入
          </button>
        </div>

        {mode === 'create' ? (
          <form onSubmit={createRoom}>
            <label>
              你的名字
              <input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} placeholder="别人会看到这个名字" />
            </label>
            <label>
              放映室标题
              <input value={title} maxLength={40} onChange={(event) => setTitle(event.target.value)} placeholder="例如：周五夜场" />
            </label>
            <label>
              房间密码
              <input
                value={password}
                maxLength={64}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="不填的话，知道房间号就能进"
                autoComplete="off"
              />
            </label>
            <button className="primary" type="submit" disabled={pending}>
              {pending ? '正在创建…' : '创建放映室'}
            </button>
          </form>
        ) : (
          <form onSubmit={joinRoom}>
            <label>
              你的名字
              <input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} placeholder="别人会看到这个名字" />
            </label>
            <label>
              房间号
              <input
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                placeholder="例如 AB12CD"
                spellCheck="false"
                autoCapitalize="characters"
              />
            </label>
            <label>
              房间密码
              <input
                value={password}
                maxLength={64}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="没有密码就留空"
                autoComplete="off"
              />
            </label>
            <button className="primary" type="submit">
              进入放映室
            </button>
          </form>
        )}

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        {lastRoom ? (
          <button className="text-button" type="button" onClick={() => navigate(`/r/${lastRoom}`)}>
            回到刚才的房间 {lastRoom}
          </button>
        ) : null}

        <p className="fine">画面从主持人的浏览器直接发给每一位观众，适合一起看的小房间。房间保存在这次服务运行的内存里，重启后会清空。</p>
      </div>
    </main>
  )
}
