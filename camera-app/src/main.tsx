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

// Unregister service worker from public/sw.js if it was previously registered
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister().then((success) => {
        if (success) {
          console.log('SW unregistered successfully');
          // Reload the page to load assets from the new build
          window.location.reload();
        }
      });
    }
  });
}

