# Visual debug harness

Orchestrator-specific glue around the generic [`termux-playwright`](../../termux-playwright/) harness — Playwright + system Chromium for visually verifying UI changes. The reusable plumbing (`launchBrowser`, `withPage`, `waitForServer`, `bootServer`) lives in the sibling repo so other Termux webapps can share it; this directory just bakes in the orchestrator's defaults (`server.js`, fake-claude, sandboxed `PROJECTS_ROOT` / `CLAUDE_PROJECTS_ROOT`).

## Prereqs

Clone the sibling repo and install its single dep:

```bash
git clone <termux-playwright-url> ~/project/termux-playwright   # if not already there
cd ~/project/termux-playwright && npm install
pkg install chromium                                            # Termux system browser
```

That's it — nothing to install in `claude-orch-app/debug/` itself. Imports resolve via `../../termux-playwright/`.

## Quick smoke test

Boot a sandboxed scratch orchestrator, snap, tear down — one process:

```bash
cd ~/project/claude-orch-app/debug
node snap.mjs --boot ./home.png
# [boot] http://127.0.0.1:<ephemeral>
# ./home.png   (PNG, headless, viewport 1280×800)
```

Or point at an already-running server:

```bash
node snap.mjs http://127.0.0.1:8787 ./home.png
```

See the sibling [`termux-playwright/README.md`](../../termux-playwright/README.md) for the full `SNAP_VIEWPORT` / `SNAP_WAIT` / `SNAP_FULL_PAGE` env-var surface and troubleshooting.

## Writing a custom debug script

Use `bootOrch()` from this directory for the orch's sandboxed-spawn shape, or `bootServer` directly from the sibling for full control. Both return a `{ url, sandbox?, close() }` object; `bootOrch({ sandbox: true })` additionally exposes `sandbox.dirs.PROJECTS_ROOT` and `sandbox.dirs.CLAUDE_PROJECTS_ROOT` so you can pre-populate disk fixtures before driving the UI.

```js
// /tmp/repro-something.mjs
import { withPage } from '../../termux-playwright/browser.mjs';
import { bootOrch } from '../claude-orch-app/debug/boot-orch.mjs';

const orch = await bootOrch({
  sandbox: true,
  scenario: '/abs/path/to/tests/fixtures/scenario-instance.json',
});
try {
  await withPage(async (page) => {
    await page.goto(orch.url);
    await page.click('text=+ New project');
    // ...
  });
} finally {
  await orch.close();
}
```

The sibling harness's "[growing the harness while debugging](../../termux-playwright/README.md#growing-the-harness-while-debugging)" guidance applies here too: ephemeral one-off scripts stay in `/tmp/`, only genuinely reusable building blocks earn a place in this directory.

## Why no Playwright test runner?

The project's existing test suite (`tests/`, node:test) covers unit + integration. This harness exists for *visual* verification — eyes on a screenshot, or interactive scripting — which the headless test runner doesn't help with. If a Playwright assertion is ever worth committing, fold it into `tests/` rather than growing a second runner here.
