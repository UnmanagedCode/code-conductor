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

// The font URL segment → the directory of the package serving it (its index.css
// and files/). The default resolves FONT_PACKAGES; another map is a test seam.
type FontDirs = Record<string, string>;
const installedFontDirs = (): FontDirs =>
  Object.fromEntries(Object.entries(FONT_PACKAGES).map(([seg, pkg]) => [seg, packageDir(pkg)]));

/** One font package's @font-face rules, its `url(./files/X)` references rewritten to the font route. Throws when it rewrote none (a fontsource layout change). */
async function fontFaces(segment: string, dir: string): Promise<string> {
  const file = path.join(dir, 'index.css');
  const css = await fs.readFile(file, 'utf8');
  let rewritten = 0;
  const out = css.replace(/url\(\.\/files\/([^)]+)\)/g, (_m, name: string) => {
    rewritten++;
    return `url(/pluginTheme/fonts/${segment}/${name})`;
  });
  if (rewritten === 0) throw new Error(`pluginTheme: ${file} has no url(./files/…) to serve`);
  return out;
}

/** The whole /pluginTheme.css body. `tokensFile` and `fontDirs` are test seams; they default to web/src/themeTokens.css and the installed FONT_PACKAGES. */
export async function composePluginTheme({ tokensFile = THEME_TOKENS, fontDirs = installedFontDirs() }: { tokensFile?: string; fontDirs?: FontDirs } = {}): Promise<string> {
  const faces = await Promise.all(Object.entries(fontDirs).map(([seg, dir]) => fontFaces(seg, dir)));
  return [
    '/* code-conductor host theme for plugin pages — docs/plugin-ui.md. Unlayered, so it wins over a plugin\'s @layer base fallback. */',
    ...faces,
    TOKENS_MARKER,
    await fs.readFile(tokensFile, 'utf8'),
  ].join('\n');
}

/** `tokensFile` and `fontDirs` are test seams (see composePluginTheme); the font route serves from the same `fontDirs`. */
export function pluginThemeRouter({ tokensFile, fontDirs }: { tokensFile?: string; fontDirs?: FontDirs } = {}): express.Router {
  const router = express.Router();
  const dirs = () => fontDirs ?? installedFontDirs();
  router.get('/pluginTheme.css', async (_req, res) => {
    try {
      const css = await composePluginTheme({ tokensFile, fontDirs: dirs() });
      res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }).send(css);
    } catch (e) {
      // The detail (paths included) goes to the log, never to the page.
      console.error('pluginTheme: /pluginTheme.css failed:', e);
      if (!res.headersSent) res.status(503).type('text/plain').send('host theme unavailable');
    }
  });
  router.get('/pluginTheme/fonts/:pkg/:file', (req, res) => {
    const all = dirs();
    const dir = Object.hasOwn(all, req.params.pkg) ? all[req.params.pkg] : null;
    if (!dir || !FONT_FILE.test(req.params.file)) { res.status(404).end(); return; }
    res.sendFile(req.params.file, { root: path.join(dir, 'files') }, (err) => {
      if (err) { if (!res.headersSent) res.status(404).end(); else res.destroy(); }
    });
  });
  return router;
}
