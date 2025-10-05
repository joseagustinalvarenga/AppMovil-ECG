import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // escucha en todas las interfaces
    allowedHosts: [
      '286b42226697.ngrok-free.app' // 👈 agregá tu host de ngrok
    ]
  }
})
