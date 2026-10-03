import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The sidecar (Java engine) listens on loopback; the UI talks to it through /api so the browser
// sees a single origin (no CORS). Override the target with SIDECAR_URL if the port differs.
const sidecar = process.env.SIDECAR_URL ?? 'http://127.0.0.1:8765'
const proxy = {
  '/api': { target: sidecar, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, '') },
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
})
