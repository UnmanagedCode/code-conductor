import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// `npm run dev:web` proxies the API to a running server (override with CC_DEV_SERVER).
const devServer = process.env.CC_DEV_SERVER || 'http://127.0.0.1:8787';
// The markdown renderer's dependency tree (`npm ls react-markdown remark-gfm --all`).
const MARKDOWN_PACKAGES = new RegExp(`[\\\\/]node_modules[\\\\/](${[
  'react-markdown', 'remark-[^\\\\/]+', 'unified', 'micromark[^\\\\/]*', 'mdast-util-[^\\\\/]+', 'hast-util-[^\\\\/]+',
  'unist-util-[^\\\\/]+', 'vfile[^\\\\/]*', 'decode-named-character-reference', 'character-entities[^\\\\/]*',
  'character-reference-invalid', 'parse-entities', 'stringify-entities', 'property-information', 'html-url-attributes',
  'style-to-object', 'inline-style-parser', 'comma-separated-tokens', 'space-separated-tokens', 'trim-lines', 'trough',
  'bail', 'devlop', 'zwitch', 'ccount', 'longest-streak', 'markdown-table', 'is-alphabetical', 'is-alphanumerical',
  'is-decimal', 'is-hexadecimal', 'is-plain-obj', 'estree-util-is-identifier-name', 'extend', '@ungap[\\\\/]structured-clone',
].join('|')})[\\\\/]`);

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    // The modules shared with the server and the node tests live in ../shared;
    // the `@shared/*` entry in tsconfig.json `paths` mirrors this one.
    alias: [
      { find: /^@shared\//, replacement: path.join(here, '..', 'shared') + '/' },
      { find: '@', replacement: path.join(here, 'src') },
    ],
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    // Served from the local machine, with the full-page views and the dialogs in
    // lazy chunks; the entry (React + Radix + the session view) is past Vite's
    // default warning size, and every boot-time rebuild would print the warning.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The logo's art data (the outlined wordmark above all) is large; the
          // logo gets its own chunk, still statically imported, so the page
          // preloads it with the entry.
          groups: [
            { name: 'logo-art', test: /[\\/]components[\\/]logo[\\/]logoArt\.ts$/ },
            // react-markdown and the unified ecosystem it pulls in (parser, GFM, mdast/hast, entity tables) get their
            // own chunk, also statically imported and preloaded with the entry.
            { name: 'markdown', test: MARKDOWN_PACKAGES },
          ],
        },
      },
    },
  },
  server: {
    // The web app imports the modules it shares with the server from ../shared.
    fs: { allow: [path.join(here, '..')] },
    proxy: {
      '/api': devServer,
      '/plugins': { target: devServer, ws: true },
      '/pluginBridge.js': devServer,
      '/pluginTheme': devServer,
      '/ws': { target: devServer.replace(/^http/, 'ws'), ws: true },
    },
  },
});
