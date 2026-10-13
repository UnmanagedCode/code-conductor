# Frontend testing

How the web UI (`web/`) is tested: its Vitest and Playwright suites ([Suites](#suites)), the `node:test` tests of the shared modules in `shared/` ([Node tests of the shared modules](#node-tests-of-the-shared-modules)), what happy-dom gets wrong, and what a headless pass through the running app (the Playwright suite `web/e2e/`, the fake CLI `tests/fake-claude.mjs`) can and cannot reach. Runner, isolation and the DOM-assert guards are in [architecture.md](architecture.md) → Testing. The Playwright harness, its fixtures, projects and flows are covered in `web/e2e/README.md`.

## What happy-dom gets wrong

| Behaviour | Browser | happy-dom | Test consequence |
|---|---|---|---|
| UA stylesheet (`[hidden] { display: none }`) | present | **absent** | `getComputedStyle(el).display === 'none'` on a `[hidden]` element is vacuous either way |
| `hashchange` after `history.pushState` / `replaceState` | never fires | **fires** (async, in order) | a view opened via `pushState` that nobody's `hashchange` listener hears still passes |
| `history.back()` / `forward()` | queued: `popstate` and the new URL arrive after the call returns; a later `replaceState` keeps the forward entries | **synchronous**, `popstate` included; a `replaceState` after a back **drops the forward entries** (`history.length` shrinks, `forward()` does nothing) | assert a Back's outcome right after the call; Forward, and `history.length` after a Back, only in a browser (`web/e2e/flows/android-shell.spec.ts`) |
| Iframe documents | loaded; a same-origin frame under a `display: none` ancestor keeps its timers, WebSocket, mic track and `AudioContext` running (headless Chromium; conditions in `keepAliveFlow`, `web/e2e/plugin-host.shared.ts`) | **never loaded** (`disableIframePageLoading`); `contentWindow` is `null` | keep-alive survival is asserted as node identity + untouched `src` + no `/start` (`web/src/features/views/pluginHost.test.tsx`); whether the page keeps running is measured only by `web/e2e/plugin-host.shared.ts` |
| `matchMedia` | evaluates against the viewport and fires `change` on a real match flip | **evaluates width queries for real** (`new Window({ width })`, `window.happyDOM.setViewport({ width })`) and fires `change` on resize, but each listener starts from "did not match": the first flip from a matching start to a non-matching one fires nothing | stub `matchMedia` and flip its answer under the mounted component to drive a breakpoint crossing (`web/src/features/session/headerLayout.test.tsx` → "crossing md moves Sync between the bar and ⋮ with no new session data"); it computes no layout, so row counts and ellipsis need the headless pass (`web/e2e/header.spec.ts`) |
| Container queries (`@container`, `@min-[…]:`) | evaluated against the container's width | **not evaluated** (no layout) | a layout that follows a column's width is a Playwright check; vitest pins only the DOM it rests on (captions, ids, groupings) |
| Layout reads (`getBoundingClientRect`, `scrollHeight`, `clientHeight`, `offsetHeight`) | real geometry | **all 0** | geometry logic takes injected rects (`web/src/conversation/stickyPrompt.test.ts` stubs a per-bubble top); whether a sticky/clamped element LOOKS right needs the headless pass |

- **Hash routing needs browser semantics.** Import `@/test/browserHash` (`web/src/test/browserHash.ts`) first in the test file, before anything that loads `state/route.ts`; its positive control is `pluginHost.test.tsx` → "a history call fires no hashchange here, and setting location.hash does".
- **Real layout (offsets, overlap) is measurable only in a browser:** a `web/e2e` spec, or `bootCc()` (`web/e2e/harness/boot.ts`) from an ad-hoc script; Playwright's Chromium, all state in a scratch root.

## Dialog tests

- **A test that opens a dialog once cannot observe its open handler's resets.** Deleting one `value = ''` from the handler leaves such a suite green.
- **The reopen pattern:** open, set every field to a non-reset value, reopen, assert the whole reset family, then `deepEqual` the request body the reset produces. The reference is `web/src/features/dialogs/adopt.test.tsx` → "reopening resets the System, the Target and the Remote dropdown, and the next adopt carries none of them", and its New-project twin in `newProject.test.tsx`.
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
  - Tool ask (`ExitPlanMode` / `AskUserQuestion`): a seeded jsonl plus kill + resume. That resume also stands in for a server restart (`resumeWithAsk` in `web/e2e/sidebar-strip.shared.ts`).

**Reachable directly:**
- plan-approval card markdown and the conversation transcript, both through `renderMarkdownInto`, which also covers the summary body;
- sidebar project / session / worktree subnodes;
- the header chip and usage popover, with an `/api/usage` fixture injected at the network boundary;
- the costs dashboard;
- settings model lists, including custom-model and backend add/delete across a hard reload;
- the spawn / conduct / promote / resume / rewind / fork / delete-project / sync / merge / conventions flows.

Injecting a fixture at the network boundary still exercises the real module.

**Headless checks are not gated.** The Playwright suite runs under `npm run test:e2e`, and a mutation run can score a mutant with any spec (`harness/mutation/README.md`), but no spec is part of `npm test`. A headless PASS with no in-suite counterpart pins nothing against regression. Where an invariant must hold, it needs a suite test.

## Suites

### Commands

| Command | Runs |
|---|---|
| `npm run test:web` | Vitest over `web/src/**/*.test.{ts,tsx}` (config: `web/vitest.config.ts`, environment `happy-dom`, setup `web/src/test/setup.ts`). Also the last step of `npm test` |
| `npm run test:e2e` | Playwright over `web/e2e/**/*.spec.ts` (config: `web/playwright.config.ts`), projects `desktop`, `phone` and `android` (`web/e2e/README.md` → Projects). Not gated |
| `npm run typecheck` | `tsc --noEmit` (server, `harness/**/*.ts`), `tsc -p web` (UI, strict) and `tsc -p web/e2e` (the Playwright suite and harness); `pretest` runs it |

First e2e run on a machine: `npx playwright install chromium` (the browser revision `@playwright/test` pins).

**Known limitation: Termux runs no Playwright spec.** `@playwright/test` has no browser there, so no browser check of the UI runs on Termux.

### Vitest suites

- **Where tests live:** beside the code, `web/src/<dir>/*.test.ts(x)`. One directory's tests run with `npx vitest run --config web/vitest.config.ts web/src/<dir>`.
- **The transcript model is tested without React.** `web/src/conversation/model.ts` is DOM-free; its tests feed UI events and assert on the node tree. Fixture transcripts in `tests/fixtures/` are replayed through the server's own `src/parser.ts` and `src/transcript.ts`, imported directly, so live and reload rendering are proved identical.
- **Components** render with `@testing-library/react` under happy-dom. Mock the network at `fetch` and the socket with `vi.mock('@shared/ws')`; never start a server in a unit test.
- **Radix Select under happy-dom** is driven by `web/src/test/radixSelect.ts`: `selectOptions` clicks the trigger (Radix opens on a non-mouse click) and asserts the menu opened, `chooseOption` then clicks the option. Options are read from `screen`, because they are portalled to `document.body`. While a Select is open, Radix marks everything else `aria-hidden`, so a `getByRole` outside the menu finds nothing until it closes. Routed and held `fetch` answers come from `web/src/test/routeFetch.ts` (`routeFetch`, `held`). The New-project and Add-project tests reach the System and Target controls through `web/src/test/placementDriver.ts`; the System row renders only once the capabilities answer, so it is always found with `findByRole`.
- **Settings tests** stub a streamed (NDJSON) answer with `ndjsonStream()` from `web/src/features/settings/test/ndjson.ts`, which `mockFetch` passes through as a `Response`, and hold an answer with `held()` from `web/src/test/routeFetch.ts`.
- **Settings edit drafts** live in module-scope stores (`modelsDraftStore`, `backendsDraftStore`, `systemsDraftStore`, and Conventions' `conventionsDraftStore` and `conventionsBlocksStore`), so a file that types into those forms captures each store's value at import and restores it in `beforeEach`, as `about.test.tsx` does for `selfUpdateStore`. A file that renders `PluginsSection` does the same for Plugins' `pluginsStore` (its lists, status lines, live logs and action guard). A file that renders `OverageCard`, alone or in the Account section, calls `discardOverageDraft()` in `beforeEach`: Account's unapplied overage edit and its status line live in `overageDraftStore`.
- **`localStorage` writes** are observed with `vi.spyOn(localStorage, 'setItem')` (or `'removeItem'`), which counts every call each time it is created. A `vi.spyOn(Storage.prototype, 'setItem')` counts 0 calls, even for a direct `localStorage.setItem`, once an earlier spy on `localStorage` or `Storage.prototype` has been restored in the same file (happy-dom 20, Vitest 5).
- **Composer attachments** live in the module-scope `attachmentStore` (`web/src/features/composer/attachments.ts`) and outlive the composer's unmount, as drafts do. A file that attaches gives every test its own session ids. A test that gives a spawning instance (no session id) a list ends by showing a session, which drops it. A list left under no session leaks into a later test: a first mount on a session drops it, and that test's `URL.revokeObjectURL` spy counts the stale preview; a first mount on a spawning instance shows it.
- **A dictation recording** lives at module scope (`web/src/features/composer/useDictation.ts`) and outlives the composer's unmount. A test that starts one ends with none running: stopped with its transcription answered, or cancelled through **Cancel**. Otherwise the next test in the file shows `Stop recording`, or a disabled button while a transcription it never answered stays pending. A touch release is a `pointerup`, a timer turn, then the `click`, as `releaseTouch` in `web/src/features/composer/composerHoldDictate.test.tsx` drives it. happy-dom performs no keyboard activation: a test models the browser's click on an unprevented Enter keydown (each auto-repeat included) and on a Space keyup whose keydown and keyup were both unprevented, as `keyDown`/`keyUp` in the same file do. The browser check (`keyboardDictateFlow` in `web/e2e/composer-dictate.shared.ts`) pins the real defaults; Playwright's `keyboard.down` on a key already down sends `repeat: true`. A landed transcript moves the focus to the box a frame later, so a step that then focuses Send waits for the box to be focused first.
- **Full-page view routing** is tested on the mounted `App` (`web/src/features/views/viewSwitch.test.tsx`, over `test/pluginHost.tsx`) with the real controller: mock `@shared/ws`, not `@/app/controller`, so `selectInstance` writes the real anchor. A lazily loaded view keeps the view it replaces in the DOM, hidden, until it loads: wait for the opened view alone before asserting what is on screen. A step back is counted with `vi.spyOn(history, 'back')`; whether Back leaves the app shows only in a browser (`web/e2e/view-switch.shared.ts`). The commit history's actions are tested standalone (`commitsActions.test.tsx`) with held list answers (`routeFetch`, `held`) and held action results.
- **The first-connect anchor restore** is tested against held reads (`web/src/app/anchorRestore.test.ts`): a fresh controller per test (`vi.resetModules`, since the read ordering is module state), every `GET /api/instances` on its own `held()` deferred, each lookup held by session id, and the `instances` hint dispatched on the mocked `bus`, so each landing order is driven explicitly. The browser check (`web/e2e/session-restore.shared.ts`) holds the reads with `page.route` and sends the hint into the page's own socket with `page.routeWebSocket`. Races between two user gestures are tested the same way in `web/src/app/gestureOrder.test.ts`: every lookup and POST held by key, a pick as a real `selectInstance({ userGesture: true })`. Answering a held route nobody requested throws `fixture check: <key> was requested`, and `drain` answers whatever an unfixed build still asks for, so a red-first run fails at its assertion instead of hanging. Closing the session the anchor names, and Back onto an entry naming an unlisted session, use the same boot in `web/src/app/closeClearsAnchor.test.ts`. The spawn dialog's race is in `web/src/features/dialogs/spawnGesture.test.tsx`, which renders the dialog over the real controller, so its pick is a real selection too.
- **Type-level pins** are `@ts-expect-error` lines in a `web/src` test file. `tsc -p web` checks them (it includes the test files); Vitest does not typecheck. Make the refused expression the argument of a call to a typed sink (`const accept = (ev: UiEvent) => ev`), so no unrelated error, such as an unused local, can satisfy the directive. Example: `web/src/conversation/unknownKind.test.ts`.
- **`@shared/*` is `shared/*`** (the alias in [architecture.md](architecture.md) → `web/`). Those modules keep their `node:test` tests in `tests/`, which import them from `shared/` as `.ts`; a Vitest test reaches them only through the alias.
- **Vitest is a devDependency.** `web/vite.config.ts` must never import it: the server's boot-time build loads that file under `npm install --omit=dev` (Docker). Test settings go in `web/vitest.config.ts`, which merges the Vite config.
- **The real builds** run only in `web/src/build.test.ts` (`// @vitest-environment node`), as the child process the server runs (`runViteBuild`, which sets `NODE_ENV=production` itself, so Vitest's `test` never reaches the build), into `os.tmpdir()` dirs; nothing there writes under `web/`. See [architecture.md](architecture.md) → Testing.

### End-to-end suite

The harness, fixtures, projects, live mode, layout checks and flows are documented in `web/e2e/README.md`. What a spec author acts on:

- **Each worker boots its own cc** (`cc` fixture, `web/e2e/harness/fixtures.ts`) in a scratch root under the temp dir: its own projects root, CLI config dir, HOME, git config and free port, an allowlisted env, and the fake CLI playing `web/e2e/fixtures/scenario.json`. `baseURL` is that server. A file's `test.use({ ccOptions })` (scenario, env, `server` name) gets a server of its own.
- **`web/dist` is built once per run by globalSetup** with the server's own hash-gated `ensureWebBuild()`; a failed build fails the run. The booted servers run with `CC_SKIP_WEB_BUILD=1` and serve that build.
- Specs navigate from the root: `page.goto('/')`, `/#session=<sid>`.
- **A toast holds while the pointer rests on it** (or after Alt+T moved focus into it; a toast reached by Tab keeps its timer): sonner pauses its timer on `mouseenter`/`mousemove` and resumes on `mouseleave`. Playwright leaves the pointer where it last acted, as Chromium does at a real phone's last tap. A toast that animates in through that point (one a top-bar control raised slides in through the bar) can get an enter with no leave and stay paused until the pointer next moves. So move the pointer clear (`page.mouse.move`) before waiting for a toast to leave, or dismiss it with its **Close toast** button. Find a toast as `[data-sonner-toast]` inside the `Notifications` region (`web/e2e/toast-header.shared.ts`).
- **Tab past a toast leaves the document:** the toaster is the page's last Tab stop, so Tab out of **Close toast** moves focus to the browser's own UI. `toBeFocused()` also requires `document.hasFocus()`, so it reads `inactive` there even where `document.activeElement` is the element. Compare against `document.activeElement`, or leave the toast by Shift+Tab (`web/e2e/toast-focus.shared.ts`).
- `web/e2e/fixtures/scenario.json` is a fake-CLI scenario: one reply with streamed tool calls (Read, Edit, Bash), thinking and markdown, then short replies. Fake-claude consumes one turn per prompt, per process.
- Seed state through the REST and MCP helpers in `web/e2e/harness/api.ts`, then drive the page.
- **A debounced write across a reload:** `page.clock.install()` before the page loads, then `page.clock.pauseAt(<page time + 1 s>)`, keeps a typed draft's save pending. The clock stays paused through a reload, so call `page.clock.resume()` once the new page has loaded, before driving it (`freezeTimers` in `web/e2e/composer-drafts.shared.ts`).
- **Absence on a drawer viewport:** a sidebar row click closes the drawer, and while it closes the page outside it is `aria-hidden`, so a role query finds nothing and `toHaveCount(0)` passes for the wrong reason. Wait first for a role query that must match, as `select` in `web/e2e/composer-attach.shared.ts` does with the `Message` textbox.
- **A microphone:** a spec file's top-level `test.use` with `launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }` and `permissions: ['microphone']` gives a real `getUserMedia` and `MediaRecorder` from a fake capture device, as `web/e2e/plugin-host.spec.ts` and `web/e2e/composer-dictate.spec.ts` (through `FAKE_MICROPHONE` in `composer-dictate.shared.ts`) do. `launchOptions` is a worker option, so Playwright refuses it inside a `describe`. For dictation, `page.route` answers `/api/transcribe/status` and `POST /api/transcribe`. A hold is a timed press: `page.mouse` on desktop, CDP `Input.dispatchTouchEvent` on phone and android, where the click can arrive a task after the finger lifts.
- **A real touch scroll** is CDP `Input.dispatchTouchEvent` (touchStart, a run of touchMove, touchEnd) on a `phone` or `android` project; it scrolls and chains at a scroller's end (`scrollOver` in `web/e2e/bubble-scroll.shared.ts`). `Input.synthesizeScrollGesture` with `gestureSourceType: 'touch'` does not scroll in this suite's headless Chromium (the same call with `'mouse'` does), and `TouchEvent`s dispatched from page JS never scroll.
- What the fake CLI cannot reach: [What the fake-CLI hand pass cannot reach](#what-the-fake-cli-hand-pass-cannot-reach).

## Node tests of the shared modules

Of the shared modules' `node:test` tests in `tests/` ([Vitest suites](#vitest-suites) → `@shared/*`), the ones that need a DOM run under happy-dom (list them with `grep -l happy-dom tests/`).

- **Asserting node identity:** write `assert.ok(a === b, msg)`, never `assert.equal(a, b)`. A node compared against a non-nullish value, or nested inside a compared structure, is a shape the DOM tripwire deliberately does not cover (header of `tests/dom-assert-tripwire.mjs`). When such an assertion fails it stalls the test child rather than failing it. A hung child in a DOM test points to this assertion shape first.
