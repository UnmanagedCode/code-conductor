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
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..');

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

// Ask the kernel for an unused TCP port on the loopback. Concurrent
// debug sessions (one per agent worktree) each get their own — no
// shared fixed port to collide on. There's a tiny TOCTOU between
// releasing here and the orchestrator binding, but in practice the
// kernel doesn't recycle that fast.
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boot the orchestrator as a child process on a free ephemeral port and
// wait for it to start serving. Returns `{ url, port, child, close() }`.
// Cleanup is wired to parent exit / SIGINT so a Ctrl+C'd debug script
// doesn't leave a stray server running.
//
//   import { bootServer, withPage } from './browser.mjs';
//   const orch = await bootServer();
//   try {
//     await withPage(async (page) => {
//       await page.goto(orch.url);
//       // ...
//     });
//   } finally { await orch.close(); }
//
// Pass `env` to override PROJECTS_ROOT / CLAUDE_PROJECTS_ROOT for
// fully-sandboxed runs (the integration test suite's pattern).
export async function bootServer({ port, env = {}, silent = false } = {}) {
  const chosenPort = port ?? await findFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ORCH_ROOT,
    env: { ...process.env, ...env, PORT: String(chosenPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!silent) {
    child.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  }
  const url = `http://127.0.0.1:${chosenPort}`;

  let exitedEarly = null;
  child.once('exit', (code, signal) => {
    exitedEarly = { code, signal };
  });

  try {
    await waitForServer(url, { timeoutMs: 15_000 });
  } catch (e) {
    if (exitedEarly) {
      throw new Error(
        `orchestrator exited before binding (code=${exitedEarly.code} signal=${exitedEarly.signal})`,
      );
    }
    child.kill('SIGTERM');
    throw e;
  }

  const cleanup = () => { if (!child.killed) child.kill('SIGTERM'); };
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  return {
    url,
    port: chosenPort,
    child,
    async close() {
      if (child.killed || child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}
