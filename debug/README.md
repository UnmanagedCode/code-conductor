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
| `check-models-responsive.mjs` | **Settings → Models** layout across a width sweep straddling the view's 840px breakpoint (narrow 320 / 360 / 390 / 719 / 721 / 839, wide 841 / 1024 / 1280 — 719 and 721 are kept although both are now inside the card range, because 721 is where boxing the tier list in a fieldset once pushed the grid's tracks past their row). Boots a sandboxed orch, seeds worst-case content (a `CUSTOM_ROLE_MAX`-length custom role on a Custom binding + a long model id bound to a tier), then per width: no document overflow; `#sm-tier-list` inside a `fieldset.sm-tiers`; every grid's resolved `grid-template-columns` + gaps fitting its content box; no sideways overflow of `.settings-content` below the breakpoint, and above it that the six-column tier grid's rightmost box fits the content column; every panel descendant contained in the panel box; no collapsed select — including the tier grid's `1fr` model column at wide widths; each `.sm-field-pair`'s two fields side by side on one line at narrow widths; ≥44px tap targets; no sibling overlap; an `aria-label` + a visible caption per control; and at wide widths that each row is still one line and the narrow rules haven't leaked up. Writes `models-<width>.png` to `--out DIR` (default `debug/screenshots/`, gitignored). Above the breakpoint it also prints a `[known]` line for the wide role row's no-wrap flex — a pre-existing overflow it deliberately does *not* assert, so it can't read as "covered". |

**Two assertions exist because a weaker check passed through the bug they cover.** `grid-tracks-fit` is separate from the containment check because a grid whose tracks exceed its content box does not shrink them — it overflows, and only whichever item reaches its track's right edge reveals it. When the tier fieldset landed, the header and all four tier rows overflowed by the same ~27px, but the rows' last item is a centre-justified radio, so only the header's last `.sm-col-header` span stuck out far enough for containment to notice. `pair-not-paired` exists because a `.sm-field-pair` that has silently re-stacked still yields two full-width selects that clear `SELECT_MIN_W`, are 44px tall, and neither overlap nor overflow — every other assertion in the file passes. Both were mutation-checked: reverting the breakpoint to 720px fails with `grid-tracks-fit` **and** `containment`; deleting `.sm-field-pair .sm-field { grid-column: auto }` fails `pair-not-paired` at all six narrow widths and nothing else.

Run it **both ways** — plain and `FORCE_SCROLLBAR_GUTTER=1`. The overlay-scrollbar run alone understates this class of problem by the gutter width (15px here): the same fieldset regression measured 25.3px of header overflow on overlay and 40.3px with a classic scrollbar.

**Capture.** `.settings-content` is an `overflow-y: auto` scroller, so the document never grows past the viewport: a plain `fullPage` shot crops to `<width>×<viewport-height>` and shows none of the seeded worst-case rows. An element screenshot of `#settings-models` was tried and rejected — it yields a correctly-sized full-height PNG whose below-fold area is **blank**, because the content is still clipped by the scroller. What ships instead: after every measurement, free the height/overflow of the scroller's **ancestors only** (`html, body, #app, #main, #settings-view`) so the page grows to full height, then `fullPage` + `clip` to the viewport width (unclipping lets the document grow sideways too, and a PNG wider than the viewport misrepresents the layout).

`.settings-content`'s own box is deliberately left as measured. Freeing its `overflow` as well — the obvious thing to do — is *not* width-neutral where scrollbars are classic rather than overlay: a reserved gutter makes `clientWidth` the padding box minus the gutter, and `overflow: visible` reserves no gutter, so the column and every row in it widen by the gutter between the measurement and the PNG (measured: 305 → 320, rows 273 → 288). The `capture-perturbed-layout` assertion compares the column's `clientWidth` either side of the unclip — `clientWidth` on both sides, since mixing in a border-box rect would itself fire on any gutter-reserving host. Run `FORCE_SCROLLBAR_GUTTER=1` to reproduce a reserved gutter on an overlay-scrollbar host and exercise that path.

Geometry loops here walk `boxesOf(row)`, which flattens `display: contents` children, **not** `row.children`: a `display: contents` element returns a zero rect from `getBoundingClientRect()`, and above the breakpoint every control sits inside such a wrapper — reading `row.children` there measures the wrappers and skips every control. The script self-checks this (`zero-box`, `uncovered-control`) so the loops can't go vacuous again unnoticed.

```bash
node debug/check-models-responsive.mjs
FORCE_SCROLLBAR_GUTTER=1 node debug/check-models-responsive.mjs
```

## Why no Playwright test runner?

Visual-only — eyes on a screenshot / interactive scripting, which the headless `tests/` (node:test) runner can't do.

A reusable Playwright **assertion** would ideally live in `tests/`, but it can't: `tests/` is the gated, dependency-free suite (`npm test` runs `tsc --noEmit` then `node:test`, no browser), and Chromium reaches this repo only through the sibling `code-playwright`. So browser-dependent checks are committed *here* as standalone scripts (see above) and the deterministic half of the same behaviour goes into `tests/` — e.g. `check-models-responsive.mjs` (geometry, browser) is paired with `tests/settings-models-field-labels.test.mjs` (the DOM contract that layout rests on, happy-dom). Split it that way rather than growing a second runner here.
