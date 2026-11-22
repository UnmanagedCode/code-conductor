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
  // Relative URLs, so one build serves at root or under any hosting prefix (CC_BASE_PATH); the client derives its base from the page URL (shared/appUrl.ts).
  base: './',
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The logo's art data (the outlined wordmark above all) is large; the
          // logo gets its own chunk, still statically imported, so the page
          // preloads it with the entry.
          groups: [
            // React, ReactDOM and the scheduler get their own chunk, statically imported and preloaded with the entry: an
            // app-only change leaves its hash, so a returning browser keeps it cached. The priority claims them before the
            // markdown group, whose dependency capture would otherwise pull React into the markdown chunk.
            { name: 'react-vendor', priority: 1, test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
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
