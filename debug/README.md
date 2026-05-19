# Visual debug harness

A small Playwright setup for driving the orchestrator's UI through the **system Chromium** installed via Termux. Useful for visually verifying changes — screenshots, DOM assertions, console inspection — without needing the desktop browser.

Kept deliberately separate from the main `package.json` so:

- the orchestrator's runtime / test dependencies don't gain a `playwright-core` chain, and
- you can wipe `debug/node_modules/` without touching `npm test`.

This directory holds **only generic infrastructure**. Feature-specific scripts go elsewhere (or stay as throwaway one-liners in the shell); the goal is reusable pieces for any current or future feature.

## Prereqs

- **Termux Chromium** (provides both the browser binary and the launcher):
  ```bash
  pkg install chromium
  which chromium-browser
  # → /data/data/com.termux/files/usr/bin/chromium-browser
  ```
- **Node 22+** (the same the orchestrator already requires).

> `playwright-core` is intentionally used instead of `playwright`. The full `playwright` package downloads its own Chromium build on install, and those builds aren't published for Android ARM. `playwright-core` exposes the same API minus the auto-download — we point `executablePath` at the system Chromium.

## Install

```bash
cd debug
npm install
```

## Quick smoke test

The fastest path — boot a scratch orchestrator on a free ephemeral port, snap, tear down, all in one process:

```bash
cd debug
node snap.mjs --boot ./home.png
# [boot] http://127.0.0.1:<ephemeral>
# ./home.png   (PNG, headless, viewport 1280×800)
```

Or, if you already have a server running (`npm start`, or `PORT=8799 node server.js` in another shell), point at it explicitly:

```bash
node snap.mjs http://127.0.0.1:8787 ./home.png
```

Open `home.png` to confirm the sidebar + chat shell rendered. If you see a blank or chrome-error image, see [Troubleshooting](#troubleshooting).

### Multi-agent / multi-worktree safe

Every `--boot` (and every `bootServer()` call) asks the kernel for a free ephemeral port via `net.createServer().listen(0)` — there's no fixed port to collide on, so several agents debugging in parallel from their own worktrees can each boot a scratch server without coordinating.

The orchestrator still reads/writes shared state under `~/project/` and `~/.claude/projects/`. That's read-mostly for visual debugging, but if you want full isolation pass an `env` override into `bootServer({ env: { PROJECTS_ROOT: '/tmp/...' , CLAUDE_PROJECTS_ROOT: '/tmp/...' } })`.

## Building blocks

### `browser.mjs`

Wraps `playwright-core`'s `chromium.launch()` with the executable path and Termux-specific flags (`--no-sandbox`, `--disable-dev-shm-usage`, etc.).

```js
import { withPage, waitForServer } from './browser.mjs';

await waitForServer('http://127.0.0.1:8787');
await withPage(async (page) => {
  await page.goto('http://127.0.0.1:8787');
  // ... drive the UI ...
  await page.screenshot({ path: 'whatever.png' });
}, { headless: true, viewport: { width: 1440, height: 900 } });
```

- `withPage(fn, opts)` — boots browser + context + page, pipes page console errors/warnings to the terminal, runs `fn(page, { browser, context })`, tears down on return or throw.
- `launchBrowser(opts)` — lower-level: returns the `Browser` directly if you need multi-context / multi-page setups.
- `waitForServer(url, { timeoutMs })` — polls until the URL responds (any non-5xx). Handy when you've just spawned a server in another shell.
- `bootServer({ port?, env?, sandbox?, silent? })` — spawns the orchestrator as a child process on a free ephemeral port (override with `port`), waits for it to bind, and returns `{ url, port, child, close() }`. Cleanup is wired to parent `exit` / `SIGINT` / `SIGTERM` so a Ctrl+C'd script never leaks a server.

```js
import { bootServer, withPage } from './browser.mjs';

const orch = await bootServer();          // ephemeral port, ~/project/ as-is
try {
  await withPage(async (page) => {
    await page.goto(orch.url);
    await page.screenshot({ path: 'home.png' });
  });
} finally {
  await orch.close();
}
```

**`sandbox: true` / `sandbox: { scenario }`** — most debug sessions want isolated state, not the real `~/project/`. Pass `sandbox: true` and `bootServer`:

- creates a tmp home with `project/` and `.claude/projects/` subdirs;
- sets `PROJECTS_ROOT`, `CLAUDE_PROJECTS_ROOT`, and `CLAUDE_BIN` (→ `tests/fake-claude.mjs`);
- exposes the paths on the returned object as `tmpHome` / `projectsRoot` / `claudeProjectsRoot`;
- wipes the tmp home in `.close()`.

Add `scenario: '<absolute path>'` to point fake-claude at a scenario file (the same `tests/fixtures/scenario-*.json` the test suite uses):

```js
const orch = await bootServer({
  sandbox: { scenario: '/path/to/tests/fixtures/scenario-instance.json' },
});
// orch.projectsRoot, orch.claudeProjectsRoot — pre-populate state here
```

Multiple concurrent debug scripts can each call `bootServer({ sandbox: true })` safely — both the port and the tmp dir are fresh per call.

Override the chromium path with `PLAYWRIGHT_CHROMIUM_BIN=/some/path` if your install lives elsewhere.

### `snap.mjs`

CLI: load a URL, save a PNG.

```bash
node snap.mjs <url> [outputPath]      # snap an already-running server
node snap.mjs --boot [outputPath]     # boot a scratch server, snap, tear down
```

- Default output: `screenshots/<ISO-timestamp>.png` (the directory is gitignored).
- `--boot` mode picks a free ephemeral port, so it's safe to run concurrently from multiple agent worktrees.
- Without `--boot`, waits up to 5s for the URL to be reachable before navigating.
- Useful env vars:
  | Var | Effect | Example |
  |---|---|---|
  | `SNAP_VIEWPORT` | Override viewport | `SNAP_VIEWPORT=375x812` (iPhone-ish) |
  | `SNAP_WAIT` | CSS selector to wait for before snapping | `SNAP_WAIT='.sidebar .session-row'` |
  | `SNAP_FULL_PAGE` | `1` → capture full scroll height | `SNAP_FULL_PAGE=1` |
  | `PLAYWRIGHT_CHROMIUM_BIN` | Override chromium binary path | `…/chrome` |

## Writing your own debug script

Drop a script anywhere — under `debug/` only if it's truly reusable infrastructure; otherwise keep it in `~/scratch/`, `/tmp/`, or just hand-type it. Pattern:

```js
// /tmp/check-foo.mjs
import { withPage, waitForServer } from './debug/browser.mjs';

await waitForServer('http://127.0.0.1:8787');
await withPage(async (page) => {
  await page.goto('http://127.0.0.1:8787');
  await page.click('text=+ New project');
  // assert, screenshot, dump page.content(), etc.
});
```

Useful page APIs for this codebase:

- `page.waitForSelector('.session-row')` — sidebar rows.
- `page.locator('header .mode-select')` — header mode dropdown.
- `page.on('websocket', ws => ws.on('framereceived', f => console.log(f.payload)))` — eavesdrop on the `/ws` stream.
- `await page.evaluate(() => window.state)` — peek at the frontend store (it's a global from `app.js`).

## Troubleshooting

**Snap produces a blank/black image.** Termux Chromium can fail silently without `--no-sandbox`; `browser.mjs` already passes it. If you ever override `extraArgs` from a custom script, keep the defaults in.

**`Failed to launch chromium because executable doesn't exist`.** Either Chromium isn't installed (`pkg install chromium`) or your install isn't at the default path; set `PLAYWRIGHT_CHROMIUM_BIN`.

**`Target page, context or browser has been closed`.** Usually a page-side JS error crashed the renderer. Page errors are already piped to the terminal via the `console`/`weberror` listeners in `withPage` — scroll up.

**Port collision when booting a scratch server.** The default 8787 may already be in use; `PORT=8799 node server.js` (or any other free port). The orchestrator binds 127.0.0.1 only.

## Why no Playwright test runner?

The project's existing test suite (`tests/`, node:test) covers unit + integration. This harness exists for *visual* verification — eyes on a screenshot, or interactive scripting — which the headless test runner doesn't help with. If a Playwright assertion is ever worth committing, fold it into the existing `tests/` setup rather than growing a second runner here.
