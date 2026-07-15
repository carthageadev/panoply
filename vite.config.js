import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The /api2 proxy forwards ScreenScraper API + media requests so the
// browser never hits screenscraper.fr directly (bypasses CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api2': {
        target: 'https://www.screenscraper.fr',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
