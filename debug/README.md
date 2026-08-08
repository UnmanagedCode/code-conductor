# Visual debug harness

Orchestrator-specific glue around the generic [`code-playwright`](../../code-playwright/) — Playwright + system Chromium for visually verifying UI changes. The reusable plumbing (`launchBrowser`, `withPage`, `waitForServer`, `bootServer`) lives in the sibling repo so other Termux webapps can share it; this directory just bakes in the orchestrator's defaults (`server.ts`, fake-claude, sandboxed `PROJECTS_ROOT` / `CLAUDE_PROJECTS_ROOT`).

## Prereqs

Clone the sibling repo to the parent directory of code-conductor and install its single dep:

```bash
cd ..
git clone git@github.com:UnmanagedCode/code-playwright.git
cd code-playwright && npm install
pkg install chromium                                            # Termux system browser
```

That's it — nothing to install in `code-conductor/debug/` itself. Imports resolve via `../../code-playwright/`.

## Quick smoke test

Boot a sandboxed scratch orchestrator, snap, tear down — one process:

```bash
cd code-conductor/debug
node snap.mjs --boot ./home.png
# [boot] http://127.0.0.1:<ephemeral>
# ./home.png   (PNG, headless, viewport 1280×800)
```

Or point at an already-running server:

```bash
node snap.mjs http://127.0.0.1:8787 ./home.png
```

See the sibling [`code-playwright/README.md`](../../code-playwright/README.md) for the full `SNAP_VIEWPORT` / `SNAP_WAIT` / `SNAP_FULL_PAGE` env-var surface and troubleshooting.

## Writing a custom debug script

Use `bootOrch()` from this directory for the orch's sandboxed-spawn shape, or `bootServer` directly from the sibling for full control. Both return a `{ url, sandbox?, close() }` object; `bootOrch({ sandbox: true })` additionally exposes `sandbox.dirs.PROJECTS_ROOT` and `sandbox.dirs.CLAUDE_PROJECTS_ROOT` so you can pre-populate disk fixtures before driving the UI.

```js
// /tmp/repro-something.mjs
import { withPage } from '../../code-playwright/browser.mjs';
import { bootOrch } from '../code-conductor/debug/boot-orch.mjs';

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

The sibling harness's "[growing the harness while debugging](../../code-playwright/README.md#growing-the-harness-while-debugging)" guidance applies here too: ephemeral one-off scripts stay in `/tmp/`, only genuinely reusable building blocks earn a place in this directory.

## Committed checks

Runnable, re-runnable, non-zero exit on failure. Not wired into `npm test` (see below).

| Script | What it asserts |
|---|---|
| `check-models-responsive.mjs` | **Settings → Models** layout across a width sweep straddling the 720px breakpoint (320 / 360 / 390 / 719 / 721 / 1024 / 1280). Boots a sandboxed orch, seeds worst-case content (a `CUSTOM_ROLE_MAX`-length custom role on a Custom binding + a long model id bound to a tier), then per width: no document or `.settings-content` sideways overflow, every panel descendant contained in the panel box, no collapsed select, ≥44px tap targets, no sibling overlap, an `aria-label` + a visible caption per control, and — at wide widths — that each row is still one line and the mobile rules haven't leaked up. Writes `models-<width>.png` to `--out DIR` (default `debug/screenshots/`, gitignored). Above the breakpoint it also prints `[known]` lines — measurements it deliberately does *not* assert (the wide role row's no-wrap flex, and the `1fr` model column's width) so a pre-existing squeeze can't read as "covered". |

```bash
node debug/check-models-responsive.mjs
```

## Why no Playwright test runner?

Visual-only — eyes on a screenshot / interactive scripting, which the headless `tests/` (node:test) runner can't do.

A reusable Playwright **assertion** would ideally live in `tests/`, but it can't: `tests/` is the gated, dependency-free suite (`npm test` runs `tsc --noEmit` then `node:test`, no browser), and Chromium reaches this repo only through the sibling `code-playwright`. So browser-dependent checks are committed *here* as standalone scripts (see above) and the deterministic half of the same behaviour goes into `tests/` — e.g. `check-models-responsive.mjs` (geometry, browser) is paired with `tests/settings-models-field-labels.test.mjs` (the DOM contract that layout rests on, happy-dom). Split it that way rather than growing a second runner here.
