import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  publicDir: path.resolve(__dirname, '..', 'assets'),
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Tauri expects a fixed port, ensure it doesn't change
    strictPort: true,
  },
  // Make envPrefix include TAURI_ for Tauri-specific env vars
  envPrefix: ['VITE_', 'TAURI_'],
})
