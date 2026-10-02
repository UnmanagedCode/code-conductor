# Frontend testing

How `public/` is tested: the happy-dom suite, what happy-dom gets wrong, and what a hand pass through the running app (`harness/playwright/`, `tests/fake-claude.mjs`, headless Chromium) can and cannot reach. Runner, isolation and the DOM-assert guards are in [architecture.md](architecture.md) → Testing. Launching the headless harness is covered in `harness/playwright/README.md`.

## What the suite reaches

- **Much of `public/` has happy-dom tests that drive the real module** (for the header, the real `installHeader()` against the real `public/index.html`). List them with `grep -l happy-dom tests/`. Before calling a frontend change "hand-verified only", check this list. A module that already has a test file gets an automated test for the change, with the hand pass on top.
- **`public/app.js` cannot be loaded** under happy-dom, so its call sites are reachable only by the hand pass; logic kept in an `installX` module is testable, logic left in `app.js` is not.
- **`public/` has no typecheck.** The `pretest` typecheck (`tsconfig.json` `include`) covers `src/`, `server.ts` and `public/**/*.d.ts` only.
- **Shared DOM harnesses carry no `.test.mjs` suffix** (`tests/spawnDialogHarness.mjs`), so `tests/run.mjs`'s readdir filter does not run them as test files. A second test file driving the same `installX` should extract its harness into one of these.
- **Asserting node identity:** write `assert.ok(a === b, msg)`, never `assert.equal(a, b)`. A node compared against a non-nullish value, or nested inside a compared structure, is a shape the DOM tripwire deliberately does not cover (header of `tests/dom-assert-tripwire.mjs`). When such an assertion fails it stalls the test child rather than failing it. A hung child in a DOM test points to this assertion shape first.

## What happy-dom gets wrong

| Behaviour | Browser | happy-dom | Test consequence |
|---|---|---|---|
| UA stylesheet (`[hidden] { display: none }`) | present | **absent** | `getComputedStyle(el).display === 'none'` on a `[hidden]` element is vacuous either way |
| `hashchange` after `history.pushState` / `replaceState` | never fires | **fires** (async, in order) | a view opened via `pushState` that nobody's `hashchange` listener hears still passes |
| Iframe documents | loaded; a same-origin frame under a `display: none` ancestor keeps its timers, WebSocket, mic track and `AudioContext` running (headless Chromium; conditions in `harness/playwright/check-plugin-keepalive.mjs`) | **never loaded** (`disableIframePageLoading`); `contentWindow` is `null` | keep-alive survival is asserted as node identity + untouched `src` + no `/start`, with a fake `contentWindow` pinned on the node where a test needs one; whether the page keeps running is measured only by that check |
| `matchMedia` | evaluates against the viewport and fires `change` on a real match flip | **evaluates width queries for real** (`new Window({ width })`, `window.happyDOM.setViewport({ width })`) and fires `change` on resize, but each listener starts from "did not match": the first resize from a matching (narrow) start to a non-matching one fires nothing | drive a breakpoint crossing by starting wide, narrowing, then widening (`tests/header-compact.test.mjs`); it computes no layout, so row counts and ellipsis need the headless pass (`tests/header-compact-browser.test.mjs`, `RUN_PLAYWRIGHT=1`) |
| Layout reads (`getBoundingClientRect`, `scrollHeight`, `clientHeight`, `offsetHeight`) | real geometry | **all 0** | geometry logic takes injected rects (`tests/sticky-prompt.test.mjs` stubs a per-bubble top); whether a sticky/clamped element LOOKS right needs the headless pass |

- **`[hidden]` is a CSS-origin invariant.** An author-origin declaration beats the UA rule at any specificity, so any author `display` on a selector that matches a `[hidden]`-bearing element un-hides it. Test it as a sweep over `public/styles.css` plus `public/index.html` and the JS-built elements listed in `JS_BUILT_HIDDEN`, not as a computed-style check:
  - `tests/hidden-attribute-layout.test.mjs` is that sweep ("nothing in index.html lays out while carrying the hidden attribute"), with one positive control per selector shape ("the sweep reports a collision declared through …").
  - It also sweeps the JS-built elements listed in `JS_BUILT_HIDDEN` ("the JS-built elements listed in JS_BUILT_HIDDEN do not lay out"), re-created in their real parent. A new JS-built element that carries `hidden` is covered only once it is added there.
  - Its stated gaps: dialog markup built in JS is not swept, and neither is any other JS-built element that toggles `hidden` outside `JS_BUILT_HIDDEN` (e.g. `.lightbox-backdrop`, `.costs-proj-detail`, `details.sub-conversation`).
- **Hash routing needs browser semantics.** Install `installBrowserHashSemantics()` (`tests/browser-hash-semantics.mjs`). It suppresses history-API `hashchange` events by matching old/new URL, not by counting, so an interleaved `location.hash =` still delivers. Its positive control is "harness: pushState/replaceState fire no hashchange, location.hash does". This applies to any test of `public/hashView.js`, `public/mainViews.js` or a `hashchange` listener.
- **Real layout (offsets, overlap) is measurable only in the headless harness:** `bootOrch({sandbox: true})` (`harness/playwright/boot-orch.mjs`), system Chromium, all state in a temp sandbox.

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
- **`awaitingUser`:**
  - Text ask: a scenario turn ending in `?` with `stop_reason: "end_turn"`, sent to a REST-spawned (non-conducted) session.
  - Tool ask (`ExitPlanMode` / `AskUserQuestion`): a seeded jsonl plus kill + resume. That resume also stands in for a server restart (`harness/playwright/check-sidebar-strip.mjs`).

**Reachable directly:**
- plan-approval card markdown and the conversation transcript, both through `renderMarkdownInto`, which also covers the summary body;
- sidebar project / session / worktree subnodes;
- the header chip and usage popover, with an `/api/usage` fixture injected at the network boundary;
- the costs dashboard;
- settings model lists, including custom-model and backend add/delete across a hard reload;
- the spawn / conduct / promote / resume / rewind / fork / delete-project / sync / merge / conventions flows.

Injecting a fixture at the network boundary still exercises the real module.

**Headless checks carry no suite evidence.** `harness/playwright/check-*.mjs` never runs under `npm test`. A headless PASS with no in-suite counterpart pins nothing against regression. Where an invariant must hold, it needs a suite test.
