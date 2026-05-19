// Thin wrapper around playwright-core that launches the Termux-installed
// system Chromium instead of Playwright's bundled binary (which doesn't
// ship for Android ARM). Use this from ad-hoc debug scripts so they don't
// all have to repeat the executablePath / flags dance.
//
//   import { withPage } from './browser.mjs';
//   await withPage(async (page) => {
//     await page.goto('http://127.0.0.1:8787');
//     await page.screenshot({ path: 'screenshots/home.png' });
//   });

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

// Default to the Termux chromium-browser launcher. Override with
// PLAYWRIGHT_CHROMIUM_BIN if you've installed Chrome elsewhere.
const DEFAULT_BIN = process.env.PLAYWRIGHT_CHROMIUM_BIN
  || '/data/data/com.termux/files/usr/bin/chromium-browser';

// Termux chromium needs --no-sandbox (no setuid sandbox helper on Android)
// and --disable-dev-shm-usage (no /dev/shm mount). The other flags reduce
// memory pressure and skip features that don't matter for visual debugging.
const TERMUX_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
];

export async function launchBrowser({
  headless = true,
  executablePath = DEFAULT_BIN,
  extraArgs = [],
} = {}) {
  if (!existsSync(executablePath)) {
    throw new Error(
      `Chromium binary not found at ${executablePath}. ` +
      `Install with \`pkg install chromium\` or set PLAYWRIGHT_CHROMIUM_BIN.`,
    );
  }
  return chromium.launch({
    headless,
    executablePath,
    args: [...TERMUX_CHROMIUM_ARGS, ...extraArgs],
  });
}

// Convenience: spin up a browser + context + page, run `fn`, tear down
// cleanly even on throw. Returns whatever `fn` returns.
export async function withPage(fn, opts = {}) {
  const browser = await launchBrowser(opts);
  try {
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    });
    // Surface page console / errors to the terminal — most of the value of
    // a visual debug session is catching things you wouldn't see in a
    // headless screenshot otherwise.
    context.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) {
        console.log(`[page ${msg.type()}] ${msg.text()}`);
      }
    });
    context.on('weberror', (e) => console.log(`[page error] ${e.error()}`));
    const page = await context.newPage();
    return await fn(page, { browser, context });
  } finally {
    await browser.close();
  }
}

// For scripts that want to wait until the orchestrator is reachable
// (e.g. you just `npm start`ed it in another shell or are about to).
export async function waitForServer(url, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok || r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms`);
}
