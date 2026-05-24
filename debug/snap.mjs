#!/usr/bin/env node
// Orchestrator-specific screenshot CLI. Opens a URL in headless Termux
// chromium and saves a PNG, or boots a sandboxed scratch orchestrator,
// snaps it, and tears down.
//
//   node snap.mjs <url> [outputPath]
//   node snap.mjs http://127.0.0.1:8787              # → screenshots/<timestamp>.png
//   node snap.mjs http://127.0.0.1:8787 home.png     # → home.png
//   node snap.mjs --boot                             # → screenshots/<timestamp>.png
//   node snap.mjs --boot home.png
//
// Useful env vars (forwarded from termux-playwright/snap.mjs):
//   PLAYWRIGHT_CHROMIUM_BIN  — override chromium path
//   SNAP_VIEWPORT            — "<w>x<h>" (default 1280x800)
//   SNAP_WAIT                — CSS selector to wait for before snapping
//   SNAP_FULL_PAGE           — "1" to capture the full scroll height

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { withPage, waitForServer } from '../../termux-playwright/browser.mjs';
import { bootOrch } from './boot-orch.mjs';

const args = process.argv.slice(2);
const bootMode = args[0] === '--boot';
if (bootMode) args.shift();

const [maybeUrl, maybeOut] = args;
let url = bootMode ? null : maybeUrl;
const outArg = bootMode ? maybeUrl : maybeOut;

if (!bootMode && !url) {
  console.error('usage: node snap.mjs <url> [outputPath]');
  console.error('       node snap.mjs --boot [outputPath]');
  process.exit(2);
}

const viewport = (() => {
  const v = process.env.SNAP_VIEWPORT;
  if (!v) return { width: 1280, height: 800 };
  const m = v.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`SNAP_VIEWPORT must be WxH, got ${v}`);
  return { width: +m[1], height: +m[2] };
})();

const outPath = outArg
  ? path.resolve(outArg)
  : path.resolve('screenshots', `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);

await mkdir(path.dirname(outPath), { recursive: true });

let orch = null;
if (bootMode) {
  orch = await bootOrch({ sandbox: true, silent: true });
  url = orch.url;
  console.error(`[boot] ${url}`);
} else {
  // Give the server a moment to come up if it was just started.
  try { await waitForServer(url, { timeoutMs: 5000 }); }
  catch (e) { console.warn(`[warn] ${e.message} — continuing anyway`); }
}

try {
  await withPage(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (process.env.SNAP_WAIT) {
      await page.waitForSelector(process.env.SNAP_WAIT, { timeout: 10_000 });
    }
    await page.screenshot({
      path: outPath,
      fullPage: process.env.SNAP_FULL_PAGE === '1',
    });
    console.log(outPath);
  }, { viewport });
} finally {
  if (orch) await orch.close();
}
