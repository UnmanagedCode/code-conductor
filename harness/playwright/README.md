# Visual debug harness

Orchestrator-specific glue around the generic [`code-playwright`](../../../code-playwright/) — Playwright + system Chromium for visually verifying UI changes. The reusable plumbing (`launchBrowser`, `withPage`, `waitForServer`, `bootServer`) lives in the sibling repo so other Termux webapps can share it; this directory just bakes in the orchestrator's defaults (`server.ts`, fake-claude, sandboxed `PROJECTS_ROOT` / `CLAUDE_PROJECTS_ROOT`).

## Prereqs

Clone the sibling repo to the parent directory of code-conductor and install its single dep:

```bash
cd ..
git clone git@github.com:UnmanagedCode/code-playwright.git
cd code-playwright && npm install
pkg install chromium                                            # Termux system browser
```

That's it — nothing to install in `code-conductor/harness/playwright/` itself. Imports resolve via `../../../code-playwright/`. `paths.mjs` holds this directory's depth-derived constants (ORCH_ROOT / ORCH_ENTRY / FAKE_CLAUDE); it stays node-builtins-only so `tests/harness-playwright-paths.test.mjs` can import it ungated.

## Quick smoke test

Boot a sandboxed scratch orchestrator, snap, tear down — one process:

```bash
cd code-conductor/harness/playwright
node snap.mjs --boot ./home.png
# [boot] http://127.0.0.1:<ephemeral>
# ./home.png   (PNG, headless, viewport 1280×800)
```

Or point at an already-running server:

```bash
node snap.mjs http://127.0.0.1:8787 ./home.png
```

See the sibling [`code-playwright/README.md`](../../../code-playwright/README.md) for the full `SNAP_VIEWPORT` / `SNAP_WAIT` / `SNAP_FULL_PAGE` env-var surface and troubleshooting.

## Writing a custom debug script

Use `bootOrch()` from this directory for the orch's sandboxed-spawn shape, or `bootServer` directly from the sibling for full control. Both return a `{ url, sandbox?, close() }` object; `bootOrch({ sandbox: true })` additionally exposes `sandbox.dirs.PROJECTS_ROOT` and `sandbox.dirs.CLAUDE_PROJECTS_ROOT` so you can pre-populate disk fixtures before driving the UI.

```js
// /tmp/repro-something.mjs
import { withPage } from '../../../code-playwright/browser.mjs';
import { bootOrch } from '../code-conductor/harness/playwright/boot-orch.mjs';

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

The sibling harness's "[growing the harness while debugging](../../../code-playwright/README.md#growing-the-harness-while-debugging)" guidance applies here too: ephemeral one-off scripts stay in `/tmp/`, only genuinely reusable building blocks earn a place in this directory.

## Committed checks

Runnable, re-runnable, non-zero exit on failure. Not wired into `npm test` (see below).

| Script | What it asserts |
|---|---|
| `check-models-responsive.mjs` | **Settings → Models** layout across a width sweep straddling the view's 850px breakpoint (narrow 320 / 360 / 390 / 719 / 721 / 849, wide 851 / 1024 / 1280 — 719 and 721 are kept although both are now inside the card range, because 721 is where boxing the tier list in a fieldset once pushed the grid's tracks past their row). Boots a sandboxed orch, seeds worst-case content (a `CUSTOM_ROLE_MAX`-length custom role on a Custom binding + a long model id bound to a tier), then per width: no document overflow; `#sm-tier-list` inside a `fieldset.sm-tiers`; every grid's resolved `grid-template-columns` + gaps fitting its content box; no sideways overflow of `.settings-content` below the breakpoint, and above it that the six-column tier grid's rightmost box fits the content column; every panel descendant contained in the panel box; no collapsed select — including the tier grid's `1fr` model column at wide widths; each `.sm-field-pair`'s two fields side by side on one line at narrow widths; ≥44px tap targets; no sibling overlap; an `aria-label` per control, and at narrow widths that **every** `.sm-field-cap` in a row renders (not just the ones on a select — the `default` radio's caption is the only label it has once `.sm-family-header` is hidden); and at wide widths that each row is still one line and the narrow rules haven't leaked up. Writes `models-<width>.png` to `--out DIR` (default `harness/playwright/screenshots/`, gitignored). Above the breakpoint it also prints a `[known]` line for the wide role row's no-wrap flex — a pre-existing overflow it deliberately does *not* assert, so it can't read as "covered". |
| `check-awaiting-wake-dot.mjs` | The **awaiting-wake sidebar dot**, end to end in a real browser: a conductor's row renders `.dot.idle.awaiting` with the tooltip `idle — waiting on a worker` while a worker it owns is mid-turn, **stays** accent across a heartbeat (a heartbeat reports without consuming the wake — the box most likely to regress silently), and drops back to plain idle at the worker's `turn_end`. Also checks the folded wake bubble is collapsible + badged, and that `list_sessions` renders `awaiting-wake yes/no`. Asserts the **class and the computed background colour**: the class alone passes under a CSS rename, the colour alone under a JS rename — both mutation-verified. This is the ONLY gate on that dot (`public/` gets no typecheck and the node:test suite never loads the render path). Writes `awaiting-wake-conductor.png` to `--out DIR` (default `harness/playwright/screenshots/`). |
| `check-sidebar-lenses.mjs` | The **sidebar lenses and conductor colour** in a real browser (desktop 1280×800, plus a 390×844 phone pass with the drawer open). Seeds three conductors — A titled + temp, B untitled + non-temp (both `playbookEnforcement: 'warn'` so they may spawn unbound workers), and C temp, the 🎼 Conduct button's own shape — with workers in a single-owner worktree (`solo-a`), a mixed worktree (`mixed`, plus a hand-spawned session) and the main checkout, a playbook-bound worker when `list_playbooks` offers an enterable stage, and seeded transcripts for B, C and one of B's main-checkout workers (fake-claude writes none; a killed session needs one to stay listed or to show as archived). A transcript is named by the **backing** session id, which the API withholds, so the script reads it from the sandbox store's `session-lineage.json`. Checks: a fresh profile opens on Missions; the `#sidebar-body` order and a full-width Conduct; mission titles (bold / muted italic) and grey chips; each `.mission` bar in `conductorColor(sid)` (imported from `/conductorColor.js` in the page); the read-only expanded tree and the `playbook · stage` line under the preview, matching `/api/instances`; a killed conductor moving under a collapsed `Inactive (1)` with a faded bar while its live worker keeps its colour; a killed **temp** conductor — archived on exit, so absent from the plain `.conduct` listing — still listed under Inactive (the sidebar fetches with `includeArchived=1`), and clicking it brings it back live **and un-archived** (absent from `GET /api/archived`); the collapsed Inactive group building no items until opened; the lens surviving a reload; the filter `<select>` and `≡` toggle at equal height and centre with the panel right-aligned; no `.conduct` row; single / mixed / main-checkout ownership bars, a killed conducted worker (always temp) archived and gone from the Sessions list, and the `solo-a` worktree head's bar clearing in place (same node, `box-shadow: none`) once its only owner's worker is killed; the conductor filter (projects hidden, mixed worktree kept plain, Worktrees open, filter row barred); the selected style (1px `--muted` outline, `--panel-2`, weight 700, owner bar kept); the session view on opening a mission; and no sideways overflow at phone width. Prints `SKIP` (never `PASS`) for the stage line when no playbook can be entered, and for distinct per-conductor colours when A and B hash to the same slot. Writes `lenses-missions.png`, `lenses-missions-expanded.png`, `lenses-projects.png`, `lenses-projects-filtered.png` and `lenses-phone.png` to `--out DIR` (default `harness/playwright/screenshots/`). |

Scenario fixtures the committed checks need live in `harness/playwright/fixtures/` (same shape as `tests/fixtures/scenario-*.json`).

**Two assertions exist because a weaker check passed through the bug they cover.** `grid-tracks-fit` is separate from the containment check because a grid whose tracks exceed its content box does not shrink them — it overflows, and only whichever item reaches its track's right edge reveals it. When the tier fieldset landed, the header and all four tier rows overflowed by the same ~27px, but the rows' last item is a centre-justified radio, so only the header's last `.sm-col-header` span stuck out far enough for containment to notice. `pair-not-paired` exists because a `.sm-field-pair` that has silently re-stacked still yields two full-width selects that clear `SELECT_MIN_W`, are 44px tall, and neither overlap nor overflow — every other assertion in the file passes. Both were mutation-checked: reverting the breakpoint to 720px fails with `grid-tracks-fit` **and** `containment` at 721px; deleting `.sm-field-pair .sm-field { grid-column: auto }` fails `pair-not-paired` at every narrow width and nothing else, as does collapsing the pair's `grid-template-columns` to a single track.

Run it **both ways** — plain and `FORCE_SCROLLBAR_GUTTER=1`. The gutter comes off the content column, so the overlay run understates every width-driven failure. Measured on the same mutant (breakpoint reverted to 720px), `span.sm-col-header` escapes `#settings-models` by **10.3px** on overlay scrollbars and **25.3px** with a classic gutter — 2.5× larger, from an identical tree.

The gutter's width is the **host's**, not ours, which is why the breakpoint is not tuned to the narrowest value that passes here. `SELECT_MIN_W` binds at an effective width (viewport − sidebar − column padding − gutter) of 826px; `max-width: 850px` puts the grid's narrowest render at 851px, clearing it for any gutter up to 25px. Tuned to 840 it would have measured exactly 100px on this 15px-gutter host and **98px on a 17px one** — a spurious failure on a clean checkout, which is worse than no check because it teaches people to ignore the output.

**Capture.** `.settings-content` is an `overflow-y: auto` scroller, so the document never grows past the viewport: a plain `fullPage` shot crops to `<width>×<viewport-height>` and shows none of the seeded worst-case rows. An element screenshot of `#settings-models` was tried and rejected — it yields a correctly-sized full-height PNG whose below-fold area is **blank**, because the content is still clipped by the scroller. What ships instead: after every measurement, free the height/overflow of the scroller's **ancestors only** (`html, body, #app, #main, #settings-view`) so the page grows to full height, then `fullPage` + `clip` to the viewport width (unclipping lets the document grow sideways too, and a PNG wider than the viewport misrepresents the layout).

`.settings-content`'s own box is deliberately left as measured. Freeing its `overflow` as well — the obvious thing to do — is *not* width-neutral where scrollbars are classic rather than overlay: a reserved gutter makes `clientWidth` the padding box minus the gutter, and `overflow: visible` reserves no gutter, so the column and every row in it widen by the gutter between the measurement and the PNG (measured: 305 → 320, rows 273 → 288). The `capture-perturbed-layout` assertion compares the column's `clientWidth` either side of the unclip — `clientWidth` on both sides, since mixing in a border-box rect would itself fire on any gutter-reserving host. Run `FORCE_SCROLLBAR_GUTTER=1` to reproduce a reserved gutter on an overlay-scrollbar host and exercise that path.

Geometry loops here walk `boxesOf(row)`, which flattens `display: contents` children, **not** `row.children`: a `display: contents` element returns a zero rect from `getBoundingClientRect()`, and above the breakpoint every control sits inside such a wrapper — reading `row.children` there measures the wrappers and skips every control. The script self-checks this (`zero-box`, `uncovered-control`) so the loops can't go vacuous again unnoticed.

```bash
node harness/playwright/check-models-responsive.mjs
FORCE_SCROLLBAR_GUTTER=1 node harness/playwright/check-models-responsive.mjs
node harness/playwright/check-awaiting-wake-dot.mjs
```

## Why no Playwright test runner?

Visual-only — eyes on a screenshot / interactive scripting, which the headless `tests/` (node:test) runner can't do.

A reusable Playwright **assertion** would ideally live in `tests/`, but it can't: `tests/` is the gated, dependency-free suite (`npm test` runs `tsc --noEmit` then `node:test`, no browser), and Chromium reaches this repo only through the sibling `code-playwright`. So browser-dependent checks are committed *here* as standalone scripts (see above) and the deterministic half of the same behaviour goes into `tests/` — e.g. `check-models-responsive.mjs` (geometry, browser) is paired with `tests/settings-models-field-labels.test.mjs` (the DOM contract that layout rests on, happy-dom). Split it that way rather than growing a second runner here.
