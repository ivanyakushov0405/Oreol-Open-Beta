import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev mode the API and WebSocket are proxied to FastAPI (python main.py, port 8000).
const backend = process.env.OREOL_BACKEND ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});
