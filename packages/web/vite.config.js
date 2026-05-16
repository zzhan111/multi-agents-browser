import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@bb-browser/shared': resolve(__dirname, '../../shared/src'),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
})
