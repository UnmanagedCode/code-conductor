import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// `npm run dev:web` proxies the API to a running server (override with CC_DEV_SERVER).
const devServer = process.env.CC_DEV_SERVER || 'http://127.0.0.1:8787';

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    // The client modules shared with the server live in public/; the
    // `@/lib/core/*` entry in tsconfig.json `paths` mirrors this one.
    alias: [
      { find: /^@\/lib\/core\//, replacement: path.join(here, '..', 'public') + '/' },
      { find: '@', replacement: path.join(here, 'src') },
    ],
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    // Served from the local machine, with the full-page views already in lazy
    // chunks; the entry (React + Radix + the session view) is past Vite's default
    // warning size, and every boot-time rebuild would print the warning.
    chunkSizeWarningLimit: 800,
  },
  server: {
    // The web app imports the modules it shares with the server from ../public.
    fs: { allow: [path.join(here, '..')] },
    proxy: {
      '/api': devServer,
      '/plugins': { target: devServer, ws: true },
      '/pluginBridge.js': devServer,
      '/ws': { target: devServer.replace(/^http/, 'ws'), ws: true },
    },
  },
});
