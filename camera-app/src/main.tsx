import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import "./styles.css";
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register service worker from public/sw.js (works in production build/preview)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => console.log('SW registered', reg))
      .catch((err) => console.warn('SW registration failed', err))
  })
}

