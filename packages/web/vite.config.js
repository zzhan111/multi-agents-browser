import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ma-browser/shared': fileURLToPath(new URL('../../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 3004,
    strictPort: true,
    host: true,
  },
})
