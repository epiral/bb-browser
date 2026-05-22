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
    port: 3004,
    strictPort: true,
    host: true,
  },
})
