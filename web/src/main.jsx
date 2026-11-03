import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import './styles.css'

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/media-sw.js').catch(() => {})
}

createRoot(document.getElementById('root')).render(<App />)
