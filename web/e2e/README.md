# web/e2e — the Playwright suite and its harness

Real cc servers driven through Chromium: the web UI at `/next/`, the old UI's checks at `/legacy/`, and the harness's own self-test. Each worker boots its own cc in a scratch root with the fake `claude` CLI; live mode (opt-in) runs a real worker. Not part of `npm test` or `test:all`. What the fake CLI can and cannot reach: `docs/frontend-testing.md`.

## Commands

| Command | Runs |
|---|---|
| `npm run test:e2e` | every project (`npx playwright test --config web/playwright.config.ts`) |
| `npx playwright test --config web/playwright.config.ts --project=desktop` | one project (`desktop`, `phone`, `android`) |
| `npx playwright test --config web/playwright.config.ts web/e2e/harness.spec.ts` | the harness self-test, in all three projects |
| `FORCE_SCROLLBAR_GUTTER=1 npx playwright test --config web/playwright.config.ts --project=desktop web/e2e/legacy/models-responsive.spec.ts` | the Models sweep with a reserved scrollbar gutter (run it both ways) |
| `CC_E2E_LIVE=1 npx playwright test --config web/playwright.config.ts --project=desktop web/e2e/live.spec.ts` | the live smoke (see Live mode) |
| `npx tsc -p web/e2e` | typecheck the specs and harness (part of `npm run typecheck`) |

- File filters are **regexes over the path**: `live.spec.ts` also matches `legacy/plugin-keepalive.spec.ts`. Name a spec by its path from the repo root.
- The browser is the revision `@playwright/test` pins: first run on a machine, `npx playwright install chromium`. Termux has none, so no spec runs there.
- `globalSetup` (`harness/global-setup.ts`) runs once per invocation: it removes the scratch roots of dead runs, then builds `web/dist` with the server's own hash-gated `ensureWebBuild()` and **fails the run if the build fails** (a stale bundle would otherwise keep serving). `web: built in …` in the output means it rebuilt.
- Output (traces, attachments) goes to `test-results/` at the repo root (gitignored; `web/` has no `package.json`, so Playwright's default `outputDir` resolves there), wiped per run. **Two Playwright invocations in one checkout — a mutation probe scoring a spec alongside `npm run test:e2e` included — clobber each other's `test-results/`**; give a hand-run invocation its own `--output <dir>`.

## Projects

| project | device | runs |
|---|---|---|
| `desktop` | Desktop Chrome, 1440×900 | everything except `**/*.android.spec.ts` |
| `phone` | Pixel 7 (portrait) | everything except `legacy/**`, `live.spec.ts`, `**/*.android.spec.ts` |
| `android` | Pixel 7, `notifications` permission granted | `harness.spec.ts`, `**/*.android.spec.ts`, `parity/**/*.spec.ts` |

`workers: 1`, `fullyParallel: false`.

- Headless Chromium runs with `--hide-scrollbars`, so no project lays out a classic scrollbar. A spec measuring a scrollbar gutter opts out with `test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })`, as `sticky-prompt.spec.ts` does; the option is worker-scoped, so that file boots its own cc.

## Fixtures (`harness/fixtures.ts`)

```ts
import { test, expect } from './harness/fixtures.ts';
test.use({ ccOptions: { server: 'my-spec', scenario: path.join(FIXTURES, 'scenario-x.json'), env: { SOME_VAR: '1' } } });
test('…', async ({ page, cc }) => { await page.goto('/next/'); /* cc.url, cc.dirs, … */ });
```

- **`cc`** — worker-scoped: one booted cc per worker. `{ url, port, engine, dirs, logPath, close() }`; `dirs` = `root`, `projects` (`PROJECTS_ROOT`), `claudeConfig` (`CLAUDE_CONFIG_DIR`), `claudeProjects` (`CLAUDE_PROJECTS_ROOT`), `home` (`HOME`), `gitconfig` (`GIT_CONFIG_GLOBAL`), `log` (the server's stdout + stderr), `workerEnv` (`FAKE_CLAUDE_ENV_DUMP`: the env the last fake worker got). The store's `sessions.json` is `dirs.projects/.code-conductor/sessions.json`.
- **`ccOptions`** — worker option, `{ server?, scenario?, env?, engine? }`:
  - `server` — a name for the file's own server. **A file that sets `ccOptions` at all gets a worker, so a cc, of its own** — even with values equal to another file's (Playwright keys a worker on where worker options are set); files that set none share one cc. A spec that seeds server state and has nothing else to set uses `{ server: '<name>' }`; every `legacy/` spec that boots a cc sets one. Pinned by `server-key/z-check.spec.ts`.
  - `scenario` — the fake CLI's scenario file; default `fixtures/scenario.json`. `fixtures/scenario.json` opens with filtered turns: a `QA-ASK` prompt raises a two-question AskUserQuestion card (tool_use `toolu_qa`, denied through the nested `can_use_tool` request `ct_qa`), a turn keyed to that deny's `request_id` `ct_qa` returns the tool result and ends the turn, and a prompt naming `Pick a QA fruit` (the card's answer) ends with a bare `result`; a `PLAN-ASK` prompt raises a plan card (tool_use `toolu_plan`, `ExitPlanMode`, denied through `ct_plan`) and a turn keyed to `ct_plan` returns the tool result and ends the turn; a `MIDTURN-HOLD` prompt emits only a `message_start` and never a `result`, so its instance stays mid-turn until it is deleted. The prompt turns are text-filtered and sit first, so no other prompt reaches them; `parity/questionCard.ts` reads the card's questions from this file.
  - `fixtures/scenario-conversation-machinery.json` (`conversation-machinery.spec.ts`): a prompt naming `MACHINERY-HOLD` starts an Agent call whose sub-agent is mid-Read and holds the turn; the session's first `set_permission_mode` control request (MCP `set_mode`, any mode) releases it with the sub-agent's result, the Agent's result carrying subagent totals (`tool_use_result`), a `system_bash` call and the reply. Every call ends in a `message_delta` with `output_tokens`, so the transcript gets per-call usage lines; every other prompt gets a plain reply with one line.
  - `fixtures/scenario-conversation-bubbles.json` (`conversation-bubbles.spec.ts`): a prompt naming `BUBBLE-HOLD` streams one bubble (a text block, a thinking block, a Bash call, then a second text block that has streamed `Streamed **so`) and holds the turn; the session's first `set_permission_mode` control request (MCP `set_mode`, any mode; `release` in `conversation-machinery.shared.ts`) finishes the block and the turn. Every other prompt gets a plain reply.
  - `env` — extra server env, applied last.
  - `engine` — `'fake'` (default) or `'live'`.
- **`baseURL`** — `cc.url`, so `page.goto('/next/')` and `request.get('/api/…')` reach this worker's server.
- **`harness/api.ts`** — `api(cc, method, route, body)` → `{ status, body }`, `createProject`, `spawnSession(cc, project, extra)` (a live cc's worker runs on `LIVE_WORKER_MODEL`), `mcpCall(cc, tool, args, callerInstanceId?)`, `installFakePlugin(cc, name)` (`tests/fixtures/fake-plugin`, id `fake-plugin`, adopted as project `name` and enabled; idempotent per cc, so specs sharing a cc may each call it).
- **`harness/transcript.ts`** — `seedTranscript(cc, id, text)` appends a user line, and `appendTranscriptRecord(cc, id, record)` appends any CLI jsonl record. fake-claude writes no transcript.
- **`harness/lineage.ts`** — `resumeSeeded(cc, project, publicId, segments)` writes one jsonl per backing segment and the session's lineage row in the store's `sessions.json`, then resumes it, so cc serves a real multi-segment walk; `seedTurns(tag, n)` builds `n` prompt/reply turns (`<tag> prompt <i>` / `<tag> reply <i>`).
- **`harness/pluginProbe.ts`** — `installProbePlugin(cc, { id, name, keepAlive })` copies `fixtures/keepalive-plugin/` into the projects root under that id, name and keep-alive, then adopts, rescans and enables it; `probeFrame(page, id)` finds the frame serving it, shown or hidden; `readProbe(page, id)` reads its counters: a per-load `nonce` (a reload makes a new one), interval `ticks`, WebSocket messages `ws`, rAF callbacks `raf`, and `mic` once its Start button ran. The fixture serves its page at every path but `/health`, so a frame loads at any subpath.
- A spec that needs no server (`legacy/header-compact.spec.ts`) imports `test` from `@playwright/test` instead, and no cc boots.

## What a booted cc gets (`harness/boot.ts`, `env.ts`, `scratch.ts`)

- **Scratch root** `<os.tmpdir()>/cc-e2e-<pid>-XXXXXX`, removed by `close()` and, if the process ends first, on `exit`, an uncaught throw, `SIGINT`, `SIGTERM` or `SIGHUP` (the server is killed first). A SIGKILLed run's roots are swept by the next run's globalSetup, keyed on the dead pid.
- **Free port** on `127.0.0.1` (never 8787), and `CC_SKIP_WEB_BUILD=1`: the server serves the build globalSetup made.
- **Allowlisted env**: only `PATH`, `LANG`, `LC_*`, `TERM`, `TZ`, `TMPDIR` pass from the runner; every path variable points into the scratch root, `GIT_CONFIG_NOSYSTEM=1`. A run started inside a cc worker therefore leaks no `CC_PROJECTS_ROOT`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` or `CLAUDE_CODE_MESSAGING_*` into the booted cc or its workers.
- **Fake engine**: `CLAUDE_BIN` = `node tests/fake-claude.mjs`, `FAKE_CLAUDE_SCENARIO`, `ANTHROPIC_API_KEY=e2e-fake-key`.
- **Readiness**: `GET /next/` answers 200 within 30 s, or the boot throws with the server log's tail (redacted).

## Live mode

`live.spec.ts`, desktop only, skipped unless `CC_E2E_LIVE=1`. The booted cc spawns the real `claude` from `PATH`; the worker under test runs on `LIVE_WORKER_MODEL` (`harness/api.ts`).

- **Credentials** (`harness/credentials.ts`): `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` is read once, in the runner process, never written. The copy at `<scratch>/claude-config/.credentials.json` (mode 0600) keeps only `claudeAiOauth.{accessToken, expiresAt, scopes, subscriptionType, rateLimitTier}` — no refresh token, nothing a later CLI adds. Refused: a missing file, no access token, a token expiring within `CC_E2E_LIVE_BUDGET_MIN` minutes (default 60), a destination inside the live config dir.
- **Global config**: `<scratch>/claude-config/.claude.json` is seeded with exactly `{"hasCompletedOnboarding":true}`. Nothing is read from or written to the live `~/.claude.json`. A CLI that still stops (onboarding, trust, auth) fails the test with its own words: the session's last events and the server log tail.
- **No leak path**: the token is registered with `redact()` (`harness/redact.ts`) before anything can print it; every harness error and log tail goes through it; the spec turns trace, screenshot and video off; the harness never prints env. The spec asserts `server.log` does not contain the token.

## Ad-hoc debugging

- **A script against a scratch cc** — keep it in `/tmp`, import the harness by absolute path, build first:
  ```ts
  // /tmp/repro.ts — node /tmp/repro.ts
  import { chromium } from '<cc checkout>/node_modules/@playwright/test/index.mjs';
  import globalSetup from '<cc checkout>/web/e2e/harness/global-setup.ts';
  import { bootCc } from '<cc checkout>/web/e2e/harness/boot.ts';
  await globalSetup();
  const cc = await bootCc({ scenario: '<abs path>/scenario.json' });
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${cc.url}/next/`);
    // …
    await browser.close();
  } finally { await cc.close(); }
  ```
- **A screenshot** — `node web/e2e/harness/snap.ts --boot <out.png>` (a scratch cc's `/next/`) or `node web/e2e/harness/snap.ts <url> <out.png>`; `SNAP_VIEWPORT=<w>x<h>` (default 1280x800), `SNAP_WAIT=<selector>`, `SNAP_FULL_PAGE=1`.

## Old-UI checks (`legacy/`)

The old UI's browser checks, driving `/legacy/` (its stable address until the cutover deletes it), `desktop` project only: each sets the viewports it measures, so Pixel 7 emulation would be a different test. Each one that needs a server boots its own cc (`ccOptions.server`); `header-compact.spec.ts` boots none. The `/next/` counterparts are parity scenarios ([Parity scenarios](#parity-scenarios)), not these.

| Spec | What it asserts |
|---|---|
| `models-responsive.spec.ts` | **Settings → Models** layout across a width sweep straddling the view's 850px breakpoint (narrow 320 / 360 / 390 / 719 / 721 / 849, wide 851 / 1024 / 1280), one test per width; 719 and 721 are inside the card range and stay in the sweep because 721 is where a fieldset around the tier list can push the grid's tracks past their row. Seeds worst-case content once per server (a `CUSTOM_ROLE_MAX`-length custom role on a Custom binding + a long model id bound to a tier), then per width: no document overflow; `#sm-tier-list` inside a `fieldset.sm-tiers`; every grid's resolved `grid-template-columns` + gaps fitting its content box; no sideways overflow of `.settings-content` below the breakpoint, and above it that the six-column tier grid's rightmost box fits the content column; every panel descendant contained in the panel box; no collapsed select — including the tier grid's `1fr` model column at wide widths; each `.sm-field-pair`'s two fields side by side on one line at narrow widths; ≥44px tap targets; no sibling overlap; an `aria-label` per control, and at narrow widths that **every** `.sm-field-cap` in a row renders (not just the ones on a select — the `default` radio's caption is the only label it has once `.sm-family-header` is hidden); and at wide widths that each row is still one line and the narrow rules haven't leaked up. Attaches `models-<width>.png`. Above the breakpoint it also adds a `known` annotation for the wide role row's no-wrap flex — a pre-existing overflow it deliberately does *not* assert, so it can't read as "covered". |
| `awaiting-wake-dot.spec.ts` | The **awaiting-wake sidebar dot**, end to end in a real browser: a conductor's row renders `.dot.idle.awaiting` with the tooltip `idle — waiting on a worker` while a worker it owns is mid-turn, **stays** accent across a heartbeat (a heartbeat reports without consuming the wake — the box most likely to regress silently), and drops back to plain idle at the worker's `turn_end`. Also checks the folded wake bubble is collapsible + badged, and that `list_sessions` renders `awaiting-wake yes/no`. Asserts the **class and the computed background colour**: the class alone passes under a CSS rename, the colour alone under a JS rename — both mutation-verified. This is the only browser check of that dot; `tests/sidebar.test.mjs` pins the class and tooltip. Attaches `awaiting-wake-conductor.png`. Runs on `fixtures/scenario-awaiting-wake.json` with `ORCH_SUBSCRIBE_TIMEOUT_MS=3000`. |
| `sidebar-lenses.spec.ts` | The **sidebar lenses and conductor colour** in a real browser (desktop 1280×800, plus a 390×844 phone pass with the drawer open). Seeds three conductors — A titled + temp, B untitled + non-temp (both `playbookEnforcement: 'warn'` so they may spawn unbound workers), and C temp, the 🎼 Conduct button's own shape — with workers in a single-owner worktree (`solo-a`), a mixed worktree (`mixed`, plus a hand-spawned session) and the main checkout, a playbook-bound worker when `list_playbooks` offers an enterable stage, and seeded transcripts for B, C and one of B's main-checkout workers (fake-claude writes none; a killed session needs one to stay listed or to show as archived). A transcript is named by the **backing** session id, which the API withholds, so the spec reads it from the scratch store's `sessions.json` (`cc.dirs.projects/.code-conductor/sessions.json`) (`.sessions[<publicId>].current`). Checks: a fresh profile opens on Conductors; the `#sidebar-body` order and a full-width Conduct; conductor titles (bold / muted italic) and chips styled live (`--text` on `--muted`, solid) vs idle (dashed) per `docs/features.md`; each `.conductor-block` bar in `conductorColor(sid)` (imported from `/conductorColor.js` in the page); the read-only expanded tree, the `↑` Make persistent button on exactly the live temp conductor and worker rows of the lens (`docs/features.md` → Temp session), and the `playbook · stage` line under the preview, matching `/api/instances`; a killed conductor moving under a collapsed `Inactive (1)` with a faded bar while its live worker keeps its colour; a killed **temp** conductor — archived on exit, so absent from the plain `.conduct` listing and listed in `GET /api/archived` — absent from every Conductors group and from the Inactive count after a reload, with B's inactive row as the proof the listing landed; the lens surviving a reload; the filter `<select>` and `≡` toggle at equal height and centre with the panel right-aligned; no `.conduct` row; single / mixed / main-checkout ownership bars, a killed conducted worker (always temp) archived and gone from the Sessions list, and the `solo-a` worktree head's bar clearing in place (same node, `box-shadow: none`) once its only owner's worker is killed; the conductor filter (projects hidden, mixed worktree kept plain, Worktrees open, filter row barred); the selected style (1px `--muted` outline, `--panel-2`, weight 700, owner bar kept); the session view on opening a conductor; and no sideways overflow at phone width. Skips (never passes) the stage-line step when no playbook can be entered, and for distinct per-conductor colours when A and B hash to the same slot. Attaches its screenshots. |
| `sidebar-strip.spec.ts` | The **needs-you strip and the waiting-on-you ring** in a real browser (desktop 1280×800, plus a 390×844 phone pass with the drawer open), on its own scenario (`fixtures/scenario-sidebar-strip.json`, with a raw `ws` client on `/ws`: tagged long turns, wake stubs, a text-ask turn, plain catch-alls). Walks each group and state: empty slot with no height; idle conductor + hand-spawned session in *Finished*; a conductor in a turn in *Running* (pulsing) while a hand-spawned one in a turn is absent; a conductor on a worker in *Running* (accent); a text ask (`wsPrompt` … `ASK-TEXT`) putting a conductor and a hand-spawned session in *Waiting on you* (amber ring, also on the conductor row); a waiting conductor on a worker staying in *Waiting* (accent fill), and **re-invoked by the worker callback** staying in *Waiting* with a green fill and no pulse; clicking the entry opening the session, then a **composer message clearing the ask** (entry → *Finished*); a **resume onto a seeded `ExitPlanMode` / `AskUserQuestion` transcript** re-deriving the ask; the three asks' `aria-label`s distinct and no state text rendered; the same strip in the Projects lens, above the toggle, nothing pinned; no worker ever listed; on the phone a strip click closing the drawer; every × drawn inside its entry's full-row box (desktop with an active entry, and phone). Each step reads the API before the DOM. Attaches `strip-conductors.png`, `strip-projects.png`, `strip-phone.png`. |
| `settings-group-restore.spec.ts` | The **Settings group nav vs. the shown group** after Chromium re-creates the page. Picks a non-default group, navigates the tab to another document and goes Back (the app's open WebSocket keeps it out of the back/forward cache, so the document is rebuilt and Chromium restores form-control values into it with no `change`, after `load`), then asserts `#settings-group-select`'s value names the one `.settings-group` not hidden — once landing straight on `#settings`, once landing elsewhere and then entering Settings. A reload row is a control: Chromium restores no form state on reload. The in-suite counterparts are the group-nav tests in `tests/settings-toggle.test.mjs` and the `autocomplete="off"` assertion in `tests/static.test.mjs`. |
| `plugin-keepalive.spec.ts` | **Plugin frontend keep-alive** (`frontend.keepAlive`) in a real browser. Copies `fixtures/keepalive-plugin/` into the scratch projects root twice and adopts, rescans and enables both through the API (a node:http backend with a 200 ms WebSocket push, and a page counting `setInterval` ticks, WebSocket messages, rAF callbacks and — after a Start click — a fake-device microphone through an `AnalyserNode`), one with `keepAlive` and one without. **A** hides `#plugin-view` directly (host-independent: the browser property alone); **B** leaves the keep-alive plugin by a `#settings` supersede and by the switcher's Conductor entry, reading the hidden frame through `page.frames()` without re-showing it, then re-enters through the switcher and asserts the same page load (nonce), continuous counters and the switcher's `(running)` label; **C** is the positive control — the same round trip on the plugin without `keepAlive` must reload. Per hidden interval it gates interval ticks and WebSocket messages (≥ 80% of expected), the track `live`, the `AudioContext` `running` with its clock advanced ≥ 0.9·hold, and non-zero RMS samples advancing; rAF is printed, not gated. B is skipped when the host's row carries no `frontendKeepAlive`. `CC_E2E_KEEPALIVE_HOLD_S` sets the hidden interval in seconds (default 5) and the test timeout with it. `CC_E2E_KEEPALIVE_HOLD_S=330` measures that the frame stays live for 330 s under a `display: none` ancestor **with Playwright's default launch flags on** — `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` — so it says nothing about Chrome's default throttling policy. |
| `main-bar-reset.spec.ts` | The main bar clears the session title and chips when Settings or a plugin view opens, and restores them on the way back (1280×800). Seeds `tests/fixtures/fake-plugin` through the API. |
| `plugin-switch.spec.ts` | Picking a plugin from the app switcher lands on it, not the placeholder, on the first try from an active session (1280×800). Same plugin seeding. |
| `plugin-version-select-width.spec.ts` | A `.pl-version` select stays inside its `.pl-actions` row, ellipsized and unfocused, whatever its options hold (a long worktree name), with no horizontal page scroll at 390×844. |
| `header-compact.spec.ts` | The one-row phone header (height, vertical centring, nothing past the viewport, the long title ellipsized, Sync out of the bar) and the desktop chip order. No cc: `public/` is served at `http://cc.test` through `page.route`, from a local server mounting what cc mounts for it (`legacyPublicTs` ahead of `express.static`), so the shared `public/*.ts` modules arrive type-stripped. |

The deterministic halves live in `tests/` (happy-dom), e.g. `models-responsive.spec.ts` ↔ `tests/settings-models-field-labels.test.mjs`, `awaiting-wake-dot.spec.ts` ↔ `tests/sidebar.test.mjs`, `header-compact.spec.ts` ↔ `tests/header-compact.test.mjs` + `tests/header-compact-css.test.mjs`.

`models-responsive.spec.ts`'s web-UI counterpart is `web/e2e/settings-models-layout.spec.ts` (`desktop` and `phone`, its own cc, the same worst-case seeds plus a user role on a Claude model). Across a viewport sweep and the sidebar's min, default and max widths it checks that nothing overflows the page, the Settings column or the Models section; that each Claude model's name fits its select wherever the column is at least a 320px phone's; that every tier and role select and every default radio shows a caption its name contains; that every control is on screen, inside the section, uncovered at its centre and clear of its row's others; and that the Settings nav sits beside or above the content with every link reachable. Its deterministic half is `web/src/features/settings/models/fieldLabels.test.tsx`; the parity scenario "Models: every tier and role select names its row, …" in `parity/settings.spec.ts` carries the shared part to `android`.

`web/e2e/settings-layout.spec.ts` (`desktop` and `phone`, its own cc seeded with unbreakable ids, names and templates, a user-added system, and page-locally served archived, plugin and library rows) loops every section in the Settings nav at the same viewports and sidebar widths and collects every violation before failing: sideways overflow of the column, the page or the section, and any control off screen, covered at its centre or overlapping another. It asserts the five sections once measured overflowing are in the nav and that each section renders at least one control.

`web/e2e/page-scroll.spec.ts` (`desktop`, `phone`) and `page-scroll.android.spec.ts` (`android`) run the bodies in `page-scroll.shared.ts` against their own cc. That cc is seeded with a project, a Haiku session and the fixture plugin. Desktop measures the project viewport and 2000×1100, and each phone project its device. The tests:
- On every Settings section in the nav, the session view (landing and live), Costs, Commits, Review and the plugin view, the document neither scrolls nor is scrolled. The shell (`#root > div:first-child`) is exactly the viewport and does not overflow.
- A probe shaped like Radix's hidden form `<input>` (absolute, no inset), appended after a spacer at the foot of each Settings section and each `ViewShell` view's content, has its containing block inside the pane. It lies within the pane's scroll height, is in view with the pane scrolled to its end, and leaves the page and the shell unscrolled. The probe is test-page DOM and is removed in the same evaluate.
- The same probe in the plugin view's `<section>`, without a spacer, has its containing block there.
- `mouse.wheel` over Settings → Models, to the pane's end and past it, scrolls only the pane. The sidebar, the Settings nav and the shell (desktop) or the Settings top bar (phone) stay in place, and the document's `scrollTop` stays 0.

## Parity scenarios

One behaviour driven against both UIs, `/legacy/` and `/next/`, on all three projects. Each proves a row of the parity ledger (`docs/frontend-testing.md` → Parity ledger) holds identically in both.

```ts
// parity/<area>.spec.ts: one file per ledger area, plus any that boot their own cc; never import `test` directly
import { expect } from '../harness/fixtures.ts';
import { parity } from './parity.ts';
parity('<ledger row id>', '<the behaviour>', async ({ page, cc, ui, uniq }) => {
  await ui.open(page);
  await ui.newProject(page, uniq('proj'));
  await expect(await ui.projectRow(page, uniq('proj'))).toBeVisible();
});
```

- **`parity(rowId, title, body)`** (`parity/parity.ts`) registers `test.describe(title)` with one test per UI in `UI_NAMES` (`parity/uis.ts`): `<title> > legacy` and `<title> > next`, each annotated `ledger-row: <rowId>`.
- **`ui`** is that half's driver (`parity/ui.ts`, `legacy` and `next`, both implementing `Ui`). Each method is one user-level operation through that UI's own controls. A method that reaches the sidebar opens the drawer itself on the Pixel 7 projects, so a scenario has no viewport branches.
- **The `legacy` driver retries its actions until their state shows:** the old UI drops clicks that land before `public/app.js` attaches its listeners. `open` waits for the sidebar's first render (the conductor filter's options), which changes no state. `switch.spec.ts` reuses its `openOldDrawer` and `expectOldUiRunning`.
- **One shared cc, unless a file boots its own.** A parity file that sets no `ccOptions` shares one cc with every other option-less spec. A file whose scenarios seed server state that would leak into that shared cc, such as live conductors, boots its own with `test.use({ ccOptions: { server: '<name>' } })` (`parity/sidebar-fleet.spec.ts`), so a ledger area may hold more than one parity file. A file that boots its own cc may also set a fake-engine scenario and server env (`parity/sidebar-wake.spec.ts`). The sidebar files share their spawn and colour helpers through `parity/fleet.ts`.
- `parity/conversation-paging.spec.ts` boots its own cc with `ORCH_SNAPSHOT_TAIL=2`, so a re-selected session's snapshot holds only its last turn and everything earlier pages in through `lineage-events`. Scenarios that need content below the tail go there; a `/next/`-only flow that needs it boots its own cc the same way (`paged-plan-card.spec.ts`; `paged-call-usage.spec.ts` uses a three-event tail so it starts on a reply's `call_usage`).
- **`uniq(s)`** is `<s>-<ui>-<project>`. Both halves of a scenario share a cc, whichever it is, so every name a scenario creates goes through `uniq`.
- **Fake engine only.** `/next/` can ignore a `#session=…` anchor on first load, so a scenario never navigates to one; it opens a session by starting it through the UI.
- **The row link:** `parity()`'s row id must name a ledger row. Once the `> next` half guards the row's behaviour, the row's `ported.by` names `web/e2e/parity/<file>.spec.ts::<title> > next`; the `> legacy` half is never a ref.
- **Adding one:** add the `parity()` call to its area's spec, and any `Ui` methods it needs to **both** drivers. Get both halves green on `desktop`, `phone` and `android`, then add the `> next` ref to the row. A behaviour the web UI lacks is fixed in `web/` first; a scenario is never committed red.
- **A remote system:** the scratch cc has no reachable provider, so a scenario that needs one answers `/api/settings/systems`, `/api/systems/<id>/remotes` and `/api/fs/dirs` itself through `page.route`, registered before `ui.open` (`routeRemoteSystem` in `parity/dialogs.spec.ts`).
- **A settings state or an unregistrable project:** a scenario that needs a settings state (tier enablement, tier efforts, the debug default) or a project the scratch cc cannot register (a remote one) rewrites `GET /api/settings/models`, `/api/settings/spawn` or `/api/projects` through `page.route` (`route.fetch()` plus a modified body, or a fixed `fulfill`), page-local and registered before `ui.open`. It never writes the shared cc's settings, which other scenarios depend on.
- **A write the shared cc must not take:** a scenario that drives one through the UI (a restart, a workspace edit, a session title, a summary generation, a prune) fulfils that route itself through `page.route`, registered before `ui.open`, and records the request body. Where the UI reads the result back (the workspace and project lists), the scenario's `GET` routes overlay its page-local state on `route.fetch()`. A restart also answers `GET /api/health` with a bootId that changes after the POST, so the UI reloads at once and the shared cc never restarts.
- **Running them:** from `web/`, one project per invocation, each with its own output dir: `npx playwright test --config playwright.config.ts --project=<desktop|phone|android> e2e/parity/ --output <dir>`.

## The android seam

The `android` project (Pixel 7 + `notifications` permission) runs `harness.spec.ts`, every `**/*.android.spec.ts` and the parity scenarios; no other project runs the `*.android.spec.ts` files. Android-only behaviour lands there: external links and the on-screen keyboard opening. The back button and a notification click behave the same on every project, so they are parity scenarios in `parity/android-shell.spec.ts` (its own cc). There the click arrives the way the installed app gets it: the page's service worker posts `cc-notification-click` to the page (`notificationClick`). The worker's own `notificationclick` handler cannot run headless, because a synthetic `NotificationEvent` is untrusted.

A `/next/`-only spec that must also run on `android` keeps its body in a `*.shared.ts`, with an `*.android.spec.ts` twin beside its desktop spec (`ls web/e2e/*.android.spec.ts`). `web/src/parity/e2eProjects.test.ts` pins the split from Playwright's own `--list` of the config: android runs every twin and none of their desktop specs, and desktop and phone run the reverse. `sidebar-chrome` branches on `test.info().project.name` to tell the desktop column from the drawer.

## Mutation scoring

A mutation run can judge a mutant with any spec here: `harness/mutation/README.md` → Three suites. A Playwright-scored row rebuilds `web/dist` through globalSetup (the mutant changes the source hash) and runs under one project, `CC_MUTATION_PW_PROJECT` (default `desktop`).

A spec's root hooks may take only `harness/fixtures.ts`'s fixtures and Playwright's own: the mutation canary is a test of that `test`, so a root hook that needs a spec-local `test.extend` fixture makes the spec unscoreable (`canary-not-established`). `harness/mutation/README.md` → "The Playwright canary".
