# web/e2e — the Playwright suite and its harness

Real cc servers driven through Chromium: the web UI at `/`, and the harness's own self-test. Each worker boots its own cc in a scratch root with the fake `claude` CLI; live mode (opt-in) runs a real worker. Not part of `npm test` or `test:all`. What the fake CLI can and cannot reach: `docs/frontend-testing.md`.

## Commands

| Command | Runs |
|---|---|
| `npm run test:e2e` | every project (`npx playwright test --config web/playwright.config.ts`) |
| `npx playwright test --config web/playwright.config.ts --project=desktop` | one project (`desktop`, `phone`, `android`) |
| `npx playwright test --config web/playwright.config.ts web/e2e/harness.spec.ts` | the harness self-test, in all three projects |
| `npx playwright test --config web/playwright.config.ts --project=desktop web/e2e/settings-models-layout.spec.ts` | one spec in one project (here the Models layout sweep) |
| `CC_E2E_LIVE=1 npx playwright test --config web/playwright.config.ts --project=desktop web/e2e/live.spec.ts` | the live smoke (see Live mode) |
| `npx tsc -p web/e2e` | typecheck the specs and harness (part of `npm run typecheck`) |

- File filters are **regexes over the path**: `header.spec.ts` also matches `flows/header.spec.ts`. Name a spec by its path from the repo root.
- The browser is the revision `@playwright/test` pins: first run on a machine, `npx playwright install chromium`. Termux has none, so no spec runs there.
- `globalSetup` (`harness/global-setup.ts`) runs once per invocation: it removes the scratch roots of dead runs, then builds `web/dist` with the server's own hash-gated `ensureWebBuild()` and **fails the run if the build fails** (a stale bundle would otherwise keep serving). `web: built in …` in the output means it rebuilt.
- Output (traces, attachments) goes to `test-results/` at the repo root (gitignored; `web/` has no `package.json`, so Playwright's default `outputDir` resolves there), wiped per run. **Two Playwright invocations in one checkout — a mutation probe scoring a spec alongside `npm run test:e2e` included — clobber each other's `test-results/`**; give a hand-run invocation its own `--output <dir>`.

## Projects

| project | device | runs |
|---|---|---|
| `desktop` | Desktop Chrome, 1440×900 | everything except `**/*.android.spec.ts` |
| `phone` | Pixel 7 (portrait) | everything except `live.spec.ts`, `**/*.android.spec.ts` |
| `android` | Pixel 7, `notifications` permission granted | `harness.spec.ts`, `**/*.android.spec.ts`, `flows/**/*.spec.ts` |

`workers: 1`, `fullyParallel: false`.

- Headless Chromium runs with `--hide-scrollbars`, so no project lays out a classic scrollbar. A spec measuring a scrollbar gutter opts out with `test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })`, as `sticky-prompt.spec.ts` does; the option is worker-scoped, so that file boots its own cc.

## Fixtures (`harness/fixtures.ts`)

```ts
import { test, expect } from './harness/fixtures.ts';
test.use({ ccOptions: { server: 'my-spec', scenario: path.join(FIXTURES, 'scenario-x.json'), env: { SOME_VAR: '1' } } });
test('…', async ({ page, cc }) => { await page.goto('/'); /* cc.url, cc.dirs, … */ });
```

- **`cc`** — worker-scoped: one booted cc per worker. `{ url, port, engine, dirs, logPath, close() }`; `dirs` = `root`, `projects` (`PROJECTS_ROOT`), `claudeConfig` (`CLAUDE_CONFIG_DIR`), `claudeProjects` (`CLAUDE_PROJECTS_ROOT`), `home` (`HOME`), `gitconfig` (`GIT_CONFIG_GLOBAL`), `log` (the server's stdout + stderr), `workerEnv` (`FAKE_CLAUDE_ENV_DUMP`: the env the last fake worker got). The store's `sessions.json` is `dirs.projects/.code-conductor/sessions.json`.
- **`ccOptions`** — worker option, `{ server?, scenario?, env?, engine? }`:
  - `server` — a name for the file's own server. **A file that sets `ccOptions` at all gets a worker, so a cc, of its own** — even with values equal to another file's (Playwright keys a worker on where worker options are set); files that set none share one cc. A spec that seeds server state and has nothing else to set uses `{ server: '<name>' }`. Pinned by `server-key/z-check.spec.ts`.
  - `scenario` — the fake CLI's scenario file; default `fixtures/scenario.json`. `fixtures/scenario.json` opens with filtered turns: a `QA-ASK` prompt raises a two-question AskUserQuestion card (tool_use `toolu_qa`, denied through the nested `can_use_tool` request `ct_qa`), a turn keyed to that deny's `request_id` `ct_qa` returns the tool result and ends the turn, and a prompt naming `Pick a QA fruit` (the card's answer) ends with a bare `result`; a `PLAN-ASK` prompt raises a plan card (tool_use `toolu_plan`, `ExitPlanMode`, denied through `ct_plan`) and a turn keyed to `ct_plan` returns the tool result and ends the turn; a `MIDTURN-HOLD` prompt emits only a `message_start` and never a `result`, so its instance stays mid-turn until it is deleted. The prompt turns are text-filtered and sit first, so no other prompt reaches them; `flows/questionCard.ts` reads the card's questions from this file.
  - `fixtures/scenario-conversation-machinery.json` (`conversation-machinery.spec.ts`): a prompt naming `MACHINERY-HOLD` starts an Agent call whose sub-agent is mid-Read and holds the turn; the session's first `set_permission_mode` control request (MCP `set_mode`, any mode) releases it with the sub-agent's result, the Agent's result carrying subagent totals (`tool_use_result`), a `system_bash` call and the reply. Every call ends in a `message_delta` with `output_tokens`, so the transcript gets per-call usage lines; every other prompt gets a plain reply with one line.
  - `fixtures/scenario-conversation-bubbles.json` (`conversation-bubbles.spec.ts`): a prompt naming `BUBBLE-HOLD` streams one bubble (a text block, a thinking block, a Bash call, then a second text block that has streamed `Streamed **so`) and holds the turn; the session's first `set_permission_mode` control request (MCP `set_mode`, any mode; `release` in `conversation-machinery.shared.ts`) finishes the block and the turn. Every other prompt gets a plain reply.
  - `env` — extra server env, applied last.
  - `engine` — `'fake'` (default) or `'live'`.
- **`baseURL`** — `cc.url`, so `page.goto('/')` and `request.get('/api/…')` reach this worker's server.
- **`harness/api.ts`** — `api(cc, method, route, body)` → `{ status, body }`, `createProject`, `spawnSession(cc, project, extra)` (a live cc's worker runs on `LIVE_WORKER_MODEL`), `mcpCall(cc, tool, args, callerInstanceId?)`, `installFakePlugin(cc, name)` (`tests/fixtures/fake-plugin`, id `fake-plugin`, adopted as project `name` and enabled; idempotent per cc, so specs sharing a cc may each call it).
- **`harness/transcript.ts`** — `seedTranscript(cc, id, text)` appends a user line, and `appendTranscriptRecord(cc, id, record)` appends any CLI jsonl record. fake-claude writes no transcript.
- **`harness/lineage.ts`** — `resumeSeeded(cc, project, publicId, segments)` writes one jsonl per backing segment and the session's lineage row in the store's `sessions.json`, then resumes it, so cc serves a real multi-segment walk; `seedTurns(tag, n)` builds `n` prompt/reply turns (`<tag> prompt <i>` / `<tag> reply <i>`).
- **`harness/pluginProbe.ts`** — `installProbePlugin(cc, { id, name, keepAlive })` copies `fixtures/keepalive-plugin/` into the projects root under that id, name and keep-alive, then adopts, rescans and enables it; `probeFrame(page, id)` finds the frame serving it, shown or hidden; `readProbe(page, id)` reads its counters: a per-load `nonce` (a reload makes a new one), interval `ticks`, WebSocket messages `ws`, rAF callbacks `raf`, and `mic` once its Start button ran. The fixture serves its page at every path but `/health`, so a frame loads at any subpath.
- A spec that boots its own cc on a port it picks before the server starts (`sw-upgrade.shared.ts`) imports `test` from `@playwright/test` instead, so no worker cc boots; it calls `bootCc({ port })` itself, with the port from `freePort()` (both `harness/boot.ts`).

## What a booted cc gets (`harness/boot.ts`, `env.ts`, `scratch.ts`)

- **Scratch root** `<os.tmpdir()>/cc-e2e-<pid>-XXXXXX`, removed by `close()` and, if the process ends first, on `exit`, an uncaught throw, `SIGINT`, `SIGTERM` or `SIGHUP` (the server is killed first). A SIGKILLed run's roots are swept by the next run's globalSetup, keyed on the dead pid.
- **Port** `port` if given, else a free one on `127.0.0.1` (never 8787), and `CC_SKIP_WEB_BUILD=1`: the server serves the build globalSetup made.
- **Allowlisted env**: only `PATH`, `LANG`, `LC_*`, `TERM`, `TZ`, `TMPDIR` pass from the runner; every path variable points into the scratch root, `GIT_CONFIG_NOSYSTEM=1`. A run started inside a cc worker therefore leaks no `CC_PROJECTS_ROOT`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` or `CLAUDE_CODE_MESSAGING_*` into the booted cc or its workers.
- **Fake engine**: `CLAUDE_BIN` = `node tests/fake-claude.mjs`, `FAKE_CLAUDE_SCENARIO`, `ANTHROPIC_API_KEY=e2e-fake-key`.
- **Readiness**: `GET /` answers 200 within 30 s, or the boot throws with the server log's tail (redacted).

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
    await page.goto(`${cc.url}/`);
    // …
    await browser.close();
  } finally { await cc.close(); }
  ```
- **A screenshot** — `node web/e2e/harness/snap.ts --boot <out.png>` (a scratch cc's `/`) or `node web/e2e/harness/snap.ts <url> <out.png>`; `SNAP_VIEWPORT=<w>x<h>` (default 1280x800), `SNAP_WAIT=<selector>`, `SNAP_FULL_PAGE=1`.

## Layout checks

Real-browser layout of the Settings view and the page shell, each on its own cc.

`web/e2e/settings-models-layout.spec.ts` (`desktop` and `phone`, its own cc, seeded with worst-case content: a long custom model id bound to a tier, a `CUSTOM_ROLE_MAX`-length user role bound to that model, and a user role on a Claude model). Across a viewport sweep and the sidebar's min, default and max widths it checks that nothing overflows the page, the Settings column or the Models section; that each Claude model's name fits its select wherever the column is at least a 320px phone's; that every tier and role select and every default radio shows a caption its name contains; that every control is on screen, inside the section, uncovered at its centre and clear of its row's others; and that the Settings nav sits beside or above the content with every link reachable. Its deterministic half is `web/src/features/settings/models/fieldLabels.test.tsx`; the flow "Models: every tier and role select names its row, …" in `flows/settings.spec.ts` carries the shared part to `android`.

`web/e2e/settings-layout.spec.ts` (`desktop` and `phone`, its own cc seeded with unbreakable ids, names and templates, a user-added system, and page-locally served archived, plugin and library rows) loops every section in the Settings nav at the same viewports and sidebar widths and collects every violation before failing: sideways overflow of the column, the page or the section, and any control off screen, covered at its centre or overlapping another. It asserts every section in `MEASURED` is in the nav and that each section renders at least one control.

`web/e2e/transcript-layout.spec.ts` (`desktop` and `phone`, the shared cc and the default scenario) measures one assistant bubble after a turn. On `phone` the avatar is stacked above the body, the body has no left gutter and spans the bubble; on `desktop` the avatar sits beside the body on the same row. On both the turn footer's first span lines up with the body's left edge. It attaches a screenshot for the visual pass.

`web/e2e/page-scroll.spec.ts` (`desktop`, `phone`) and `page-scroll.android.spec.ts` (`android`) run the bodies in `page-scroll.shared.ts` against their own cc. That cc is seeded with a project, a Haiku session and the fixture plugin. Desktop measures the project viewport and 2000×1100, and each phone project its device. The tests:
- On every Settings section in the nav, the session view (landing and live), Costs, Commits, Review and the plugin view, the document neither scrolls nor is scrolled. The shell (`#root > div:first-child`) is exactly the viewport and does not overflow. Once capabilities have pruned it, the nav lists exactly `offeredSections(SECTION_CATALOG, …)` (`web/src/features/settings/sections.ts`, imported by the spec) for `/api/health`'s capabilities. Each section shows a control; Archived gets one served session page-locally.
- A probe shaped like Radix's hidden form `<input>` (absolute, no inset), appended after a spacer at the foot of each Settings section and each `ViewShell` view's content, has its containing block inside the pane. It lies within the pane's scroll height, is in view with the pane scrolled to its end, and leaves the page and the shell unscrolled. The probe is test-page DOM and is removed in the same evaluate.
- The same probe in the plugin view's `<section>`, without a spacer, has its containing block there.
- A small box appended straight to the shell at `top: 200vh`, outside every pane, leaves the document unscrolled: the shell's own `relative` is the backstop clip.
- `mouse.wheel` over Settings → Models, to the pane's end and past it, scrolls only the pane. The sidebar, the Settings nav and the shell (desktop) or the Settings top bar (phone) stay in place, and the document's `scrollTop` stays 0.

## Flows

User-level flows through the web UI's own controls, one spec file per area under `flows/`, on all three projects.

```ts
// flows/<area>.spec.ts: take `test` from ./test.ts, never from the harness directly
import { expect, test } from './test.ts';
test('<the behaviour>', async ({ page, cc, ui, uniq }) => {
  await ui.open(page);
  await ui.newProject(page, uniq('proj'));
  await expect(await ui.projectRow(page, uniq('proj'))).toBeVisible();
});
```

- **`test`** (`flows/test.ts`) is the harness's `test` extended with two fixtures, `ui` and `uniq`.
- **`ui`** is the web UI's driver, `next` (`flows/ui.ts`, implementing `Ui`). Each method is one user-level operation through the UI's own controls. A method that reaches the sidebar opens the drawer itself on the Pixel 7 projects, so a flow has no viewport branches.
- **`uniq(s)`** is `<s>-<project>`. A spec file's flows share one cc across the projects, so every name a flow creates goes through `uniq`.
- **One shared cc, unless a file boots its own.** A flow file that sets no `ccOptions` shares one cc with every other option-less spec. A file whose flows seed server state that would leak into that shared cc, such as live conductors, boots its own with `test.use({ ccOptions: { server: '<name>' } })` (`flows/sidebar-fleet.spec.ts`), so an area may hold more than one flow file. A file that boots its own cc may also set a fake-engine scenario and server env (`flows/sidebar-wake.spec.ts`). The sidebar files share their spawn and colour helpers through `flows/fleet.ts`; `flows/foldedBubbles.ts`, `flows/questionCard.ts` and `flows/stickyPin.ts` are shared helpers too.
- `flows/conversation-paging.spec.ts` boots its own cc with `ORCH_SNAPSHOT_TAIL=2`, so a re-selected session's snapshot holds only its last turn and everything earlier pages in through `lineage-events`. Flows that need content below the tail go there; a spec outside `flows/` that needs it boots its own cc the same way (`paged-plan-card.spec.ts`; `paged-call-usage.spec.ts` uses a three-event tail so it starts on a reply's `call_usage`).
- **Fake engine only.** A flow opens a session by starting it through the UI, never by navigating to a `#session=…` anchor.
- **Adding one:** add the `test` to its area's spec, and any `Ui` methods it needs to `next`. Get it green on `desktop`, `phone` and `android`. A behaviour the web UI lacks is fixed in `web/` first; a flow is never committed red.
- **A remote system:** the scratch cc has no reachable provider, so a flow that needs one answers `/api/settings/systems`, `/api/systems/<id>/remotes` and `/api/fs/dirs` itself through `page.route`, registered before `ui.open` (`routeRemoteSystem` in `flows/dialogs.spec.ts`).
- **A settings state or an unregistrable project:** a flow that needs a settings state (tier enablement, tier efforts, the debug default) or a project the scratch cc cannot register (a remote one) rewrites `GET /api/settings/models`, `/api/settings/spawn` or `/api/projects` through `page.route` (`route.fetch()` plus a modified body, or a fixed `fulfill`), page-local and registered before `ui.open`. It never writes the shared cc's settings, which other flows depend on.
- **A write the shared cc must not take:** a flow that drives one through the UI (a restart, a workspace edit, a session title, a summary generation, a prune) fulfils that route itself through `page.route`, registered before `ui.open`, and records the request body. Where the UI reads the result back (the workspace and project lists), the flow's `GET` routes overlay its page-local state on `route.fetch()`. A restart also answers `GET /api/health` with a bootId that changes after the POST, so the UI reloads at once and the shared cc never restarts.
- **Running them:** from `web/`, one project per invocation, each with its own output dir: `npx playwright test --config playwright.config.ts --project=<desktop|phone|android> e2e/flows/ --output <dir>`.

## The android seam

The `android` project (Pixel 7 + `notifications` permission) runs `harness.spec.ts`, every `**/*.android.spec.ts` and the flows; no other project runs the `*.android.spec.ts` files. Android-only behaviour lands there: external links and the on-screen keyboard opening. The back button and a notification click behave the same on every project, so they are flows in `flows/android-shell.spec.ts` (its own cc). There the click arrives the way the installed app gets it: the page's service worker posts `cc-notification-click` to the page (`notificationClick`). The worker's own `notificationclick` handler cannot run headless, because a synthetic `NotificationEvent` is untrusted.

A spec outside `flows/` that must also run on `android` keeps its body in a `*.shared.ts`, with an `*.android.spec.ts` twin beside its desktop spec (`ls web/e2e/*.android.spec.ts`). `web/src/e2eProjects.test.ts` pins the split from Playwright's own `--list` of the config: android runs every twin and none of their desktop specs, and desktop and phone run the reverse. `sidebar-chrome` branches on `test.info().project.name` to tell the desktop column from the drawer.

## Mutation scoring

A mutation run can judge a mutant with any spec here: `harness/mutation/README.md` → Three suites. A Playwright-scored row rebuilds `web/dist` through globalSetup (the mutant changes the source hash) and runs under one project, `CC_MUTATION_PW_PROJECT` (default `desktop`).

A spec's root hooks may take only `harness/fixtures.ts`'s fixtures and Playwright's own: the mutation canary is a test of that `test`, so a root hook that needs a spec-local `test.extend` fixture makes the spec unscoreable (`canary-not-established`). `harness/mutation/README.md` → "The Playwright canary".
