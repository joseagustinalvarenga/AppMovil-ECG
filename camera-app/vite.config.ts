import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 👇 reemplazá "90296b7228d5.ngrok-free.app" por el dominio que te dio ngrok
export default defineConfig({
  plugins: [react()],
  server: {
  host: true,
  allowedHosts: ['.ngrok-free.app'], // permite cualquier subdominio de ngrok
  },
})
