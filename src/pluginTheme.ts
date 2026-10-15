// The host theme served to plugin pages: GET /pluginTheme.css is the Geist
// @font-face rules of the installed fontsource packages, a `/* cc:tokens */`
// marker line, then web/src/themeTokens.css — the file the host's own
// index.css imports — composed per request from those sources, so it answers
// with no web build in place and cannot drift from the host's tokens. The font
// files the rules point at are served under /pluginTheme/fonts/<pkg>/<file>.
// Contract: docs/plugins.md → Theme stylesheet.
import express from 'express';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { WEB_ROOT } from './webBuild.ts';

const THEME_TOKENS = path.join(WEB_ROOT, 'src', 'themeTokens.css');
const FONT_FILE = /^[a-z0-9-]+\.woff2$/;
const TOKENS_MARKER = '/* cc:tokens */';

// The font URL segment → the fontsource package behind it.
const FONT_PACKAGES: Record<string, string> = {
  geist: '@fontsource-variable/geist',
  'geist-mono': '@fontsource-variable/geist-mono',
};

const require = createRequire(import.meta.url);
/** The package's directory, from its resolved main stylesheet (index.css). */
const packageDir = (pkg: string) => path.dirname(require.resolve(pkg));

/** One font package's @font-face rules, its `url(./files/X)` references rewritten to the font route. Throws when it rewrote none (a fontsource layout change). */
async function fontFaces(segment: string, pkg: string): Promise<string> {
  const css = await fs.readFile(path.join(packageDir(pkg), 'index.css'), 'utf8');
  let rewritten = 0;
  const out = css.replace(/url\(\.\/files\/([^)]+)\)/g, (_m, file: string) => {
    rewritten++;
    return `url(/pluginTheme/fonts/${segment}/${file})`;
  });
  if (rewritten === 0) throw new Error(`pluginTheme: ${pkg}/index.css has no url(./files/…) to serve`);
  return out;
}

/** The whole /pluginTheme.css body. `tokensFile` is a test seam; it defaults to web/src/themeTokens.css. */
export async function composePluginTheme(tokensFile = THEME_TOKENS): Promise<string> {
  const faces = await Promise.all(Object.entries(FONT_PACKAGES).map(([seg, pkg]) => fontFaces(seg, pkg)));
  return [
    '/* code-conductor host theme for plugin pages — docs/plugin-ui.md. Unlayered, so it wins over a plugin\'s @layer base fallback. */',
    ...faces,
    TOKENS_MARKER,
    await fs.readFile(tokensFile, 'utf8'),
  ].join('\n');
}

/** `tokensFile` is a test seam, passed to composePluginTheme. */
export function pluginThemeRouter({ tokensFile }: { tokensFile?: string } = {}): express.Router {
  const router = express.Router();
  router.get('/pluginTheme.css', async (_req, res) => {
    let css: string;
    try {
      css = await composePluginTheme(tokensFile);
    } catch (e) {
      // The detail (paths included) goes to the log, never to the page.
      console.error('pluginTheme: /pluginTheme.css failed:', e);
      res.status(503).type('text/plain').send('host theme unavailable');
      return;
    }
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }).send(css);
  });
  router.get('/pluginTheme/fonts/:pkg/:file', (req, res) => {
    const pkg = Object.hasOwn(FONT_PACKAGES, req.params.pkg) ? FONT_PACKAGES[req.params.pkg] : null;
    if (!pkg || !FONT_FILE.test(req.params.file)) { res.status(404).end(); return; }
    res.sendFile(req.params.file, { root: path.join(packageDir(pkg), 'files') }, (err) => {
      if (err) { if (!res.headersSent) res.status(404).end(); else res.destroy(); }
    });
  });
  return router;
}
