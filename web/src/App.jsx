import { useEffect, useState } from 'react'
import { Lobby } from './lobby.jsx'
import { Room } from './room.jsx'

export function App() {
  const [path, setPath] = useState(window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function navigate(next) {
    window.history.pushState({}, '', next)
    setPath(window.location.pathname)
  }

  const match = path.match(/^\/r\/([A-Za-z0-9]{4,12})\/?$/)
  if (match) return <Room code={match[1].toUpperCase()} navigate={navigate} />
  return <Lobby navigate={navigate} />
}
