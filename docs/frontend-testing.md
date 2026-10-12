# Frontend testing

How `public/` is tested: the happy-dom suite, what happy-dom gets wrong, and what a headless pass through the running app (the Playwright suite `web/e2e/`, the fake CLI `tests/fake-claude.mjs`) can and cannot reach. Runner, isolation and the DOM-assert guards are in [architecture.md](architecture.md) → Testing. The Playwright harness, its fixtures and the ported old-UI checks are covered in `web/e2e/README.md`.

The web UI (`web/`) has its own Vitest and Playwright suites: [The web UI](#the-web-ui-web), at the end.

## What the suite reaches

- **Much of `public/` has happy-dom tests that drive the real module** (for the header, the real `installHeader()` against the real `public/index.html`). List them with `grep -l happy-dom tests/`. Before calling a frontend change "hand-verified only", check this list. A module that already has a test file gets an automated test for the change, with the hand pass on top.
- **`public/app.js` cannot be loaded** under happy-dom. Logic kept in an `installX` module is testable directly. Code left in `app.js` is testable by slicing the real source of a self-contained statement out of `app.js` by regex (a function, a callback handler, an `installX({...})` call, the `dom` map), then either:
  - **lift-and-run** — build it with `new Function(...)` over stubs for every free name it uses and assert on what it calls (`tests/app-refresh-projects-wiring.test.mjs`, `tests/app-models-change-wiring.test.mjs`, `tests/app-sticky-prompt-wiring.test.mjs`); or
  - **lift-and-assert** — assert on the sliced source text itself, where the wiring is a fixed mapping rather than behaviour (`tests/stats-call-usage-wiring.test.mjs`; `tests/adopt-dialog-markup.test.mjs` pins the adopt dialog's `dom`-map entries in `app.js` against the ids in `index.html`).

  Assert the slice matched, so a rename or reshape fails loudly instead of testing nothing. What no single statement holds (the order of the bootstrap) is reachable only by the hand pass.
- **The old UI's `public/*.js` has no typecheck.** What the `pretest` typecheck covers is `tsconfig.json` `include`: of `public/` it takes the shared `public/*.ts` modules and no `public/*.js`; `tsc -p web` also checks those `.ts` modules through web's imports. `tests/public-ts-modules.test.mjs` pins the handler that serves them to the old UI as JS (`src/legacyPublicTs.ts`).
- **Shared DOM harnesses carry no `.test.mjs` suffix** (`tests/spawnDialogHarness.mjs`), so `tests/run.mjs`'s readdir filter does not run them as test files. A second test file driving the same `installX` should extract its harness into one of these.
- **Asserting node identity:** write `assert.ok(a === b, msg)`, never `assert.equal(a, b)`. A node compared against a non-nullish value, or nested inside a compared structure, is a shape the DOM tripwire deliberately does not cover (header of `tests/dom-assert-tripwire.mjs`). When such an assertion fails it stalls the test child rather than failing it. A hung child in a DOM test points to this assertion shape first.

## What happy-dom gets wrong

| Behaviour | Browser | happy-dom | Test consequence |
|---|---|---|---|
| UA stylesheet (`[hidden] { display: none }`) | present | **absent** | `getComputedStyle(el).display === 'none'` on a `[hidden]` element is vacuous either way |
| `hashchange` after `history.pushState` / `replaceState` | never fires | **fires** (async, in order) | a view opened via `pushState` that nobody's `hashchange` listener hears still passes |
| `history.back()` / `forward()` | queued: `popstate` and the new URL arrive after the call returns; a later `replaceState` keeps the forward entries | **synchronous**, `popstate` included; a `replaceState` after a back **drops the forward entries** (`history.length` shrinks, `forward()` does nothing) | assert a Back's outcome right after the call; Forward, and `history.length` after a Back, only in a browser (`web/e2e/parity/android-shell.spec.ts`) |
| Iframe documents | loaded; a same-origin frame under a `display: none` ancestor keeps its timers, WebSocket, mic track and `AudioContext` running (headless Chromium; conditions in `web/e2e/legacy/plugin-keepalive.spec.ts`) | **never loaded** (`disableIframePageLoading`); `contentWindow` is `null` | keep-alive survival is asserted as node identity + untouched `src` + no `/start`, with a fake `contentWindow` pinned on the node where a test needs one; whether the page keeps running is measured only by that check and, on /next/, by `web/e2e/plugin-host.shared.ts` |
| `matchMedia` | evaluates against the viewport and fires `change` on a real match flip | **evaluates width queries for real** (`new Window({ width })`, `window.happyDOM.setViewport({ width })`) and fires `change` on resize, but each listener starts from "did not match": the first resize from a matching (narrow) start to a non-matching one fires nothing | drive a breakpoint crossing by starting wide, narrowing, then widening (`tests/header-compact.test.mjs`); it computes no layout, so row counts and ellipsis need the headless pass (`web/e2e/legacy/header-compact.spec.ts`) |
| Container queries (`@container`, `@min-[…]:`) | evaluated against the container's width | **not evaluated** (no layout) | a layout that follows a column's width is a Playwright check; vitest pins only the DOM it rests on (captions, ids, groupings) |
| Layout reads (`getBoundingClientRect`, `scrollHeight`, `clientHeight`, `offsetHeight`) | real geometry | **all 0** | geometry logic takes injected rects (`tests/sticky-prompt.test.mjs` stubs a per-bubble top); whether a sticky/clamped element LOOKS right needs the headless pass |

- **`[hidden]` is a CSS-origin invariant.** An author-origin declaration beats the UA rule at any specificity, so any author `display` on a selector that matches a `[hidden]`-bearing element un-hides it. Test it as a sweep over `public/styles.css` plus `public/index.html` and the JS-built elements listed in `JS_BUILT_HIDDEN`, not as a computed-style check:
  - `tests/hidden-attribute-layout.test.mjs` is that sweep ("nothing in index.html lays out while carrying the hidden attribute"), with one positive control per selector shape ("the sweep reports a collision declared through …").
  - It also sweeps the JS-built elements listed in `JS_BUILT_HIDDEN` ("the JS-built elements listed in JS_BUILT_HIDDEN do not lay out"), re-created in their real parent. A new JS-built element that carries `hidden` is covered only once it is added there.
  - Its stated gaps: dialog markup built in JS is not swept, and neither is any other JS-built element that toggles `hidden` outside `JS_BUILT_HIDDEN` (e.g. `.lightbox-backdrop`, `.costs-proj-detail`, `details.sub-conversation`).
- **Hash routing needs browser semantics.** Install `installBrowserHashSemantics()` (`tests/browser-hash-semantics.mjs`). It suppresses history-API `hashchange` events by matching old/new URL, not by counting, so an interleaved `location.hash =` still delivers. Its positive control is "harness: pushState/replaceState fire no hashchange, location.hash does". This applies to any test of `public/hashView.js`, `public/mainViews.js` or a `hashchange` listener. In `web/`, import `@/test/browserHash` first in the test file, before anything that loads `state/route.ts`; its positive control is `pluginHost.test.tsx` → "a history call fires no hashchange here, and setting location.hash does".
- **Real layout (offsets, overlap) is measurable only in a browser:** a `web/e2e` spec, or `bootCc()` (`web/e2e/harness/boot.ts`) from an ad-hoc script; Playwright's Chromium, all state in a scratch root.

## Dialog tests

- **A test that opens a dialog once cannot observe its open handler's resets.** Deleting one `value = ''` from the handler leaves such a suite green.
- **The reopen pattern:** open, set every field to a non-reset value, reopen, assert the whole reset family, then `deepEqual` the request body the reset produces. The reference is "reopening the dialog resets every field the previous open left behind" (`tests/adopt-project-dialog.test.mjs`). `tests/new-project-placement.test.mjs` still opens once per test.
- A reset that another function always rewrites before anything reads it is unobservable. Trace which resets are like that instead of asserting on them.

## What the fake-CLI hand pass cannot reach

`fake-claude` writes no session jsonl. `FAKE_CLAUDE_TRANSCRIPT` is a log of its stdin, not a CLI transcript. Every surface that reads the session transcript therefore fails or stays empty.

| Surface | Why unreachable |
|---|---|
| Session-summary dialog (markdown body and cost row) | generation fails `session not found`: no jsonl |
| Rewind / fork happy path | refused `… (session has 0 user prompts)` (`src/sessionEdit.ts`). The affordances, confirm strings and failure alert *are* reachable |
| Prune apply | the analysis finds ~0 prunable tokens, so the apply button never enables |
| Lazy history "load earlier" | the transcript never grows past the snapshot tail |
| OS notification body | headless Chromium refuses `ServiceWorkerRegistration.showNotification` without a grantable permission |
| Backend-specific rows (e.g. a substitution backend's `—` cost) | no such backend configured |
| A dead worker's session row changing in place | conducted workers are temp, so killing one archives it and its row leaves the list. A persistent node (a worktree head) still shows in-place changes; a session row's change needs a happy-dom test |

**Reachable with seeding:**
- **A session on disk after exit** (Inactive/archived rows, resume): seed a jsonl named by the session's **backing** id, read from the sandbox store's `sessions.json` → `.sessions[<publicId>].current`. A file named by the public id matches no archive marker, and a check can go green on it by accident.
- **A harness conductor that spawns unbound workers** needs `playbookEnforcement: 'warn'`.
- **An overage queue** (`overage_message_queued`, then `system`/`auto_resume`): send the server's frames into the page's own WebSocket with Playwright's `page.routeWebSocket` (`queuedGhostsFlow` in `web/e2e/conversation-bubbles.shared.ts`). A real queue needs the account-usage monitor, the Stop & resume policy and a reset deadline.
- **A send the server refuses** (an acked `prompt` that can't reach the CLI): route the page's socket with `page.routeWebSocket`, answer the chosen `prompt` frame with `{ t: 'ack', reqId, ok: false, error }` and forward every other frame to `ws.connectToServer()` (`refuseMarkedPrompts` in `web/e2e/paged-plan-card.shared.ts`). The fake engine never refuses one.
- **Read-aloud without a Piper voice:** fulfil `GET /api/tts/status` with `{ available: true }`, and read what a tap would speak from the `POST /api/tts` request body, answered with an empty `200` (`speechSeam` in `web/e2e/conversation-bubbles.shared.ts`).
- **`awaitingUser`:**
  - Text ask: a scenario turn ending in `?` with `stop_reason: "end_turn"`, sent to a REST-spawned (non-conducted) session.
  - Tool ask (`ExitPlanMode` / `AskUserQuestion`): a seeded jsonl plus kill + resume. That resume also stands in for a server restart (`web/e2e/legacy/sidebar-strip.spec.ts`).

**Reachable directly:**
- plan-approval card markdown and the conversation transcript, both through `renderMarkdownInto`, which also covers the summary body;
- sidebar project / session / worktree subnodes;
- the header chip and usage popover, with an `/api/usage` fixture injected at the network boundary;
- the costs dashboard;
- settings model lists, including custom-model and backend add/delete across a hard reload;
- the spawn / conduct / promote / resume / rewind / fork / delete-project / sync / merge / conventions flows.

Injecting a fixture at the network boundary still exercises the real module.

**Headless checks are not gated.** The ported old-UI checks (`web/e2e/legacy/`) run under `npm run test:e2e` with the rest of `web/e2e`, and a mutation run can score a mutant with any spec (`harness/mutation/README.md`), but no spec is part of `npm test` or `test:all`. A headless PASS with no in-suite counterpart pins nothing against regression. Where an invariant must hold, it needs a suite test.

## The web UI (`web/`)

### Commands

| Command | Runs |
|---|---|
| `npm run test:web` | Vitest over `web/src/**/*.test.{ts,tsx}` (config: `web/vitest.config.ts`, environment `happy-dom`, setup `web/src/test/setup.ts`). Not part of `npm test` |
| `npm run test:all` | `npm test && npm run test:web`: red if either suite is. The gate for work touching `web/` |
| `npm run test:e2e` | Playwright over `web/e2e/**/*.spec.ts` (config: `web/playwright.config.ts`), projects `desktop`, `phone` and `android` (`web/e2e/README.md` → Projects). Not gated |
| `npm run typecheck` | `tsc --noEmit` (server, `harness/**/*.ts`), `tsc -p web` (UI, strict) and `tsc -p web/e2e` (the Playwright suite and harness); `pretest` runs it |

First e2e run on a machine: `npx playwright install chromium` (the browser revision `@playwright/test` pins).

**Known limitation: Termux runs no Playwright spec.** `@playwright/test` has no browser there, and that includes the old-UI checks in `web/e2e/legacy/`, so no browser check of `public/` runs on Termux. The gap lasts until the cutover deletes the old UI, and those checks with it.

### Vitest suites

- **Where tests live:** beside the code, `web/src/<dir>/*.test.ts(x)`. One directory's tests run with `npx vitest run --config web/vitest.config.ts web/src/<dir>`.
- **The transcript model is tested without React.** `web/src/conversation/model.ts` is DOM-free; its tests feed UI events and assert on the node tree. Fixture transcripts in `tests/fixtures/` are replayed through the server's own `src/parser.ts` and `src/transcript.ts`, imported directly, so live and reload rendering are proved identical.
- **Components** render with `@testing-library/react` under happy-dom. Mock the network at `fetch` and the socket with `vi.mock('@/lib/core/ws.js')`; never start a server in a unit test.
- **Radix Select under happy-dom** is driven by `web/src/test/radixSelect.ts`: `selectOptions` clicks the trigger (Radix opens on a non-mouse click) and asserts the menu opened, `chooseOption` then clicks the option. Options are read from `screen`, because they are portalled to `document.body`. While a Select is open, Radix marks everything else `aria-hidden`, so a `getByRole` outside the menu finds nothing until it closes. Routed and held `fetch` answers come from `web/src/test/routeFetch.ts` (`routeFetch`, `held`). The New-project and Add-project tests reach the System and Target controls through `web/src/test/placementDriver.ts`; the System row renders only once the capabilities answer, so it is always found with `findByRole`.
- **Settings tests** stub a streamed (NDJSON) answer with `ndjsonStream()` from `web/src/features/settings/test/ndjson.ts`, which `mockFetch` passes through as a `Response`, and hold an answer with `held()` from `web/src/test/routeFetch.ts`.
- **Settings edit drafts** live in module-scope stores (`modelsDraftStore`, `backendsDraftStore`, `systemsDraftStore`, and Conventions' `conventionsDraftStore` and `conventionsBlocksStore`), so a file that types into those forms captures each store's value at import and restores it in `beforeEach`, as `about.test.tsx` does for `selfUpdateStore`. A file that renders `PluginsSection` does the same for Plugins' `pluginsStore` (its lists, status lines, live logs and action guard). A file that renders `OverageCard`, alone or in the Account section, calls `discardOverageDraft()` in `beforeEach`: Account's unapplied overage edit and its status line live in `overageDraftStore`.
- **`localStorage` writes** are observed with `vi.spyOn(localStorage, 'setItem')` (or `'removeItem'`), which counts every call each time it is created. A `vi.spyOn(Storage.prototype, 'setItem')` counts 0 calls, even for a direct `localStorage.setItem`, once an earlier spy on `localStorage` or `Storage.prototype` has been restored in the same file (happy-dom 20, Vitest 5).
- **Composer attachments** live in the module-scope `attachmentStore` (`web/src/features/composer/attachments.ts`) and outlive the composer's unmount, as drafts do. A file that attaches gives every test its own session ids. A test that gives a spawning instance (no session id) a list ends by showing a session, which drops it. A list left under no session leaks into a later test: a first mount on a session drops it, and that test's `URL.revokeObjectURL` spy counts the stale preview; a first mount on a spawning instance shows it.
- **A dictation recording** lives at module scope (`web/src/features/composer/useDictation.ts`) and outlives the composer's unmount. A test that starts one ends with none running: stopped with its transcription answered, or cancelled through **Cancel**. Otherwise the next test in the file shows `Stop recording`, or a disabled button while a transcription it never answered stays pending. A touch release is a `pointerup`, a timer turn, then the `click`, as `releaseTouch` in `web/src/features/composer/composerHoldDictate.test.tsx` drives it.
- **Full-page view routing** is tested on the mounted `App` (`web/src/features/views/viewSwitch.test.tsx`, over `test/pluginHost.tsx`) with the real controller: mock `@/lib/core/ws.js`, not `@/app/controller`, so `selectInstance` writes the real anchor. A lazily loaded view keeps the view it replaces in the DOM, hidden, until it loads: wait for the opened view alone before asserting what is on screen. A step back is counted with `vi.spyOn(history, 'back')`; whether Back leaves the app shows only in a browser (`web/e2e/view-switch.shared.ts`). The commit history's actions are tested standalone (`commitsActions.test.tsx`) with held list answers (`routeFetch`, `held`) and held action results.
- **The first-connect anchor restore** is tested against held reads (`web/src/app/anchorRestore.test.ts`): a fresh controller per test (`vi.resetModules`, since the read ordering is module state), every `GET /api/instances` on its own `held()` deferred, each lookup held by session id, and the `instances` hint dispatched on the mocked `bus`, so each landing order is driven explicitly. The browser check (`web/e2e/session-restore.shared.ts`) holds the reads with `page.route` and sends the hint into the page's own socket with `page.routeWebSocket`. Races between two user gestures are tested the same way in `web/src/app/gestureOrder.test.ts`: every lookup and POST held by key, a pick as a real `selectInstance({ userGesture: true })`. Answering a held route nobody requested throws `fixture check: <key> was requested`, and `drain` answers whatever an unfixed build still asks for, so a red-first run fails at its assertion instead of hanging. The spawn dialog's race is in `web/src/features/dialogs/spawnGesture.test.tsx`, which renders the dialog over the real controller, so its pick is a real selection too.
- **`@/lib/core/*` is `public/*`** (the alias in [architecture.md](architecture.md) → `web/`). Those modules keep their `node:test` tests in `tests/`, which import them from `public/`; a Vitest test reaches them only through the alias.
- **`import.meta.env.BASE_URL` is `/` under Vitest**, whatever `base` the Vite config sets. Code that needs the base path imports `WEB_BASE` from `web/base.ts`, which a test observes as `/next/`.
- **Model-switch parity.** The Change-model cases in `features/session/header.test.tsx` each name the old-UI test in `tests/header-change-model.test.mjs` they mirror; a behaviour change to one picker updates both.
- **Vitest is a devDependency.** `web/vite.config.ts` must never import it: the server's boot-time build loads that file under `npm install --omit=dev` (Docker). Test settings go in `web/vitest.config.ts`, which merges the Vite config.
- **The real builds** run only in `web/src/build.test.ts` (`// @vitest-environment node`), under `NODE_ENV=production` (Vitest's `test` would build the development bundle), into `os.tmpdir()` dirs; nothing there writes under `web/`. See [architecture.md](architecture.md) → Testing.

### End-to-end suite

The harness, fixtures, projects, live mode and every ported check are documented in `web/e2e/README.md`. What a spec author acts on:

- **Each worker boots its own cc** (`cc` fixture, `web/e2e/harness/fixtures.ts`) in a scratch root under the temp dir: its own projects root, CLI config dir, HOME, git config and free port, an allowlisted env, and the fake CLI playing `web/e2e/fixtures/scenario.json`. `baseURL` is that server. A file's `test.use({ ccOptions })` (scenario, env, `server` name) gets a server of its own.
- **`web/dist` is built once per run by globalSetup** with the server's own hash-gated `ensureWebBuild()`; a failed build fails the run. The booted servers run with `CC_SKIP_WEB_BUILD=1` and serve that build.
- Specs navigate under the base: `page.goto('/next/')`, `/next/#session=<sid>`. The ported old-UI checks drive `/legacy/`.
- **A toast holds while the pointer rests on it** (or focus is inside it): sonner pauses its timer on `mouseenter`/`mousemove` and resumes on `mouseleave`. Playwright leaves the pointer where it last acted, as Chromium does at a real phone's last tap. A toast that animates in through that point (one a top-bar control raised slides in through the bar) can get an enter with no leave and stay paused until the pointer next moves. So move the pointer clear (`page.mouse.move`) before waiting for a toast to leave, or dismiss it with its **Close toast** button. Find a toast as `[data-sonner-toast]` inside the `Notifications` region (`web/e2e/toast-header.shared.ts`).
- `web/e2e/switch.spec.ts` drives both UIs: `/` → **Try the new UI** → `/next/` → **Classic UI** → `/legacy/`, opening each UI's drawer first on the phone project. It counts the old UI as running only once its JS answers (the Projects lens toggles `aria-pressed`), not when its HTML arrives.
- `web/e2e/fixtures/scenario.json` is a fake-CLI scenario: one reply with streamed tool calls (Read, Edit, Bash), thinking and markdown, then short replies. Fake-claude consumes one turn per prompt, per process.
- Seed state through the REST and MCP helpers in `web/e2e/harness/api.ts`, then drive the page.
- **A debounced write across a reload:** `page.clock.install()` before the page loads, then `page.clock.pauseAt(<page time + 1 s>)`, keeps a typed draft's save pending. The clock stays paused through a reload, so call `page.clock.resume()` once the new page has loaded, before driving it (`freezeTimers` in `web/e2e/composer-drafts.shared.ts`).
- **Absence on a drawer viewport:** a sidebar row click closes the drawer, and while it closes the page outside it is `aria-hidden`, so a role query finds nothing and `toHaveCount(0)` passes for the wrong reason. Wait first for a role query that must match, as `select` in `web/e2e/composer-attach.shared.ts` does with the `Message` textbox.
- **A microphone:** a spec file's top-level `test.use` with `launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }` and `permissions: ['microphone']` gives a real `getUserMedia` and `MediaRecorder` from a fake capture device, as `web/e2e/plugin-host.spec.ts` and `web/e2e/composer-dictate.spec.ts` (through `FAKE_MICROPHONE` in `composer-dictate.shared.ts`) do. `launchOptions` is a worker option, so Playwright refuses it inside a `describe`. For dictation, `page.route` answers `/api/transcribe/status` and `POST /api/transcribe`. A hold is a timed press: `page.mouse` on desktop, CDP `Input.dispatchTouchEvent` on phone and android, where /next/'s click can arrive a task after the finger lifts.
- What the fake CLI cannot reach is the same as for the old UI: [What the fake-CLI hand pass cannot reach](#what-the-fake-cli-hand-pass-cannot-reach).

## Parity ledger

`tests/web-parity/ledger.ts` is the frontend-rework epic's migration ledger: one row per old-UI behaviour, each statused against the web UI as it stands. The cutover to the web UI deletes it together with the old UI and its tests.

- **The gate:** `the ledger` in `web/src/parity/ledger.test.ts` (`// @vitest-environment node`), part of `npm run test:web`, so of `test:all`. Alone: `npx vitest run --config web/vitest.config.ts web/src/parity`. Its failure message prints one problem per line. It carries its own longer timeout, because it parses the whole tree in one synchronous block; the value is set on the test itself.
- **The modules:** `tests/web-parity/inventory.ts` (what must be accounted for), `titles.ts` (static title resolution), `check.ts` (`buildWorld` reads the tree, `checkLedger` is pure). The fixture tests in the same test file pin each.

### What must be accounted for

`oldUiInventory` computes it from the tree; nothing lists it by hand.

- **Old-UI-only `public/` files:** every file under `public/` minus the shared set. Shared = each `public/*.ts`, plus every `@/lib/core/<x>` module a string in `web/src/**/*.{ts,tsx}` names, plus, transitively, those modules' own relative imports.
- **An old-UI test:** a top-level `tests/*.test.mjs` whose strings reference an old-UI-only file, in itself or in the `tests/*.mjs` helpers it imports (`import`, `export … from`, `import()`, transitively). A string `s` references file `X` when:
  - `s` is `public/X` or ends with `/public/X`; or
  - the same file has a string that is `public`, ends with `/public` or `/public/`, or contains `public/`, and `s` is `X` or ends with `/X` and contains no `web/` (this catches `path.join(ROOT, 'public', 'x.js')`).
- Strings are the AST's string literals and template parts (Vite's `parseSync`), so a mention in a comment never counts.
- **Plus** every `web/e2e/legacy/**/*.spec.ts`.
- A helper (no `.test.mjs` suffix) is never a row; its tests are accounted through the files that import it.

### Rows

A `Row` has an `id`, an `old` source, a `behaviour`, the `viewports` it exists on, an `area` (one of `AREAS`; the follow-up work to close the gaps is split by area) and a `status`.

- **`old`** is a test file with optional `tests`, or a `### ` heading of `docs/features.md` for a documented behaviour no old test guards.
- **`old.tests`:** omitted = the whole file; a list = exact full titles; `'rest'` = every title of the file that no other row and no `SURVIVES` entry lists.
- **`SURVIVES`:** titles in inventoried files that test no old-UI behaviour (server or shared-module code). The cutover keeps them, and moves them out of any file it deletes.

| `status.kind` | Meaning |
|---|---|
| `ported` | `by` names existing new-UI tests that guard the same observable behaviour. Browser-level behaviour (real geometry, computed colour, iframe liveness, real scroll) is ported only by a Playwright spec on `/next/` |
| `missing` | The default when unsure, including "the web UI has the feature but no test guards it" |
| `regressed` | The web UI has the surface but behaves differently; `evidence` names the code |
| `dropped` | The user ruled the behaviour gone. `ruling` names a `RULINGS` entry holding the date and the user's words; nothing else may drop a row |

**Granularity:**
- One row per behaviour. A file is split when its tests differ in coverage or area, or when part of it is ruled.
- A `ported` row lists its titles explicitly, never whole-file or `'rest'`, so a test later added to its file is never counted as ported: it lands in the file's `'rest'` row if there is one, and otherwise in no row, which fails `partition`.
- A file with an explicit-titles row, a `'rest'` row, several rows or a `SURVIVES` entry is partitioned exactly: rows plus `SURVIVES` cover every title, `SURVIVES` overlaps no row, and at most one row is `'rest'`.
- **Legacy specs** hold one or two long tests, so several rows may name the same title. Each row then stands for the behaviour box its `behaviour` names, and the title is covered only once every row naming it is `ported` or `dropped`. The check cannot see a box:
  - the reviewer of a change that flips a legacy row checks its `behaviour` against the test it cites;
  - before deleting a legacy spec, the cutover confirms that every row naming its titles is `ported` or `dropped`.

**Refs** (`TestRef`, `<repo-relative file>::<full title>`) name a `web/src/**/*.test.ts(x)`, a `web/e2e/**/*.spec.ts` outside `web/e2e/legacy/`, or a `tests/*.test.mjs` that is not inventoried. An inventoried `tests/` file is allowed only for a title in its `SURVIVES` entry. A parity scenario's `> legacy` half is never a ref.

### Static title resolution

`testTitles` reads a file's full titles from its AST; no suite runs. Full title = the enclosing titles and the test's own, joined by ` > `. Describe-level titles are titles too.

- **A title node** is a call to `test`, `it`, `describe` or `suite`, with member modifiers (`MODIFIERS` in `titles.ts`) and `.each(…)`/`.for(…)` peeled, so `test.describe.serial` and node:test's `t.test` resolve. Its first argument is a string or template literal, and a later argument is a function or an identifier.
- **A template title** is its raw source text, `${…}` included.
- **One-hop wrappers:** a top-level function whose body calls a base callee with the function's own first parameter as the title is a callee too. A wrapper of a wrapper is not.
- **Not seen: a non-literal title**, such as `test(label, …)` or `t.test(JSON.stringify(v), …)` in a loop. Its children resolve under the parent, so a row names the parent title.
- **`parity('<row id>', '<title>', fn)`** contributes `<title> > legacy` and `<title> > next`, and links the scenario to its row.

### Problems

| `kind` | Reported when |
|---|---|
| `unaccounted` | An inventoried file has no row |
| `stale-row` | A row's file is not inventoried |
| `stale-survivor` | A `SURVIVES` entry's file is not inventoried |
| `bad-ref` | A `by` ref has no `::`, names a non-test file, a legacy spec, an inventoried `tests/` title outside its `SURVIVES`, or a parity `> legacy` half |
| `unresolved-ref` | A ref's file does not exist, or its title is not one the file declares |
| `unruled-drop` | A `dropped` row's ruling is absent, has blank text, or has no real `YYYY-MM-DD` date |
| `empty-id` | A row's `id` is empty; the subject is its position, `LEDGER[<index>]` |
| `duplicate-id` | Two rows share a non-empty `id` |
| `partition` | A split file breaks the granularity rule above (the detail names the titles in no row), or any `SURVIVES` entry lists a title its file does not declare |
| `unknown-section` | A docs row's `section` is not a `### ` heading of `docs/features.md` |
| `unknown-parity-row` | A `parity()` call names no ledger row |
| `bad-parity-call` | A `parity()` call's row id or title is not a literal |

### Flipping a row

1. Fix the behaviour in `web/` if the web UI lacks it.
2. Add a new-UI test that guards the row's behaviour: a Vitest test, or a parity scenario (`web/e2e/README.md` → Parity scenarios) for a behaviour both UIs share.
3. Set the row's `status` to `ported`, its `by` naming that test (a scenario by its `> next` half), once every title in the row is guarded. If only part is guarded, split the row first.
