import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Dev server: used when running `vite --port 3001`
  server: {
    port: 3001,
    strictPort: true,
  },
  // Production build: write panel.html + assets into ../src
  // (same dir that Tauri bundles as frontendDist).
  // emptyOutDir:false so popup files (index.html, styles.css, main.js) survive.
  build: {
    outDir: path.resolve(__dirname, '../src'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'panel.html'),
    },
  },
});
