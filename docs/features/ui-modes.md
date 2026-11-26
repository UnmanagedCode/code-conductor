# UI modes

Every cc boot runs in exactly one **UI mode**, chosen with `--ui` (`parseEntryArgs`, `src/headless/args.ts`; the mode names are `UI_MODES` in `shared/uiMode.ts`):

| Mode | What the web UI allows |
|---|---|
| `full` | Everything: the normal UI. |
| `view` | Nothing that changes state: a spectator UI, so a phone can watch without a stray tap changing anything. |
| `interact` | `view` everywhere except the **focused root session** (`GET /api/health`'s `focus.sessionId`; a URL `?focus=` marker never counts), which the human can control. |

**A UX convenience, not access control.** cc has no auth; the only server-side enforcement is a launchless replay's `create()` refusal (`409 VIEW_REPLAY_NO_LAUNCH`, below). The REST API, `/mcp` and a plugin page's own requests stay open in every mode. Changing the mode means restarting cc with another `--ui`.

## Choosing a mode

| Boot | Allowed `--ui` | Default |
|---|---|---|
| Ordinary server (`node server.ts`, `npm start`) | `full`, `view` (`SERVER_UI_MODES`) | `full` |
| Headless run (`--prompt` / `--prompt-file`) | `full`, `view`, `interact` | `view` |
| Replay (`--replay`) | `full`, `view`, `interact` | `view` |

- Both spellings: `--ui view`, `--ui=view`. `--ui` alone never makes a boot headless.
- An ordinary server refuses `--ui interact` (it has no focused session), a repeated `--ui`, a missing or empty value and an unknown value: the message and the synopsis go to stderr and the process exits **2** before it takes the root lock or listens. A headless run or replay reports the same errors as one `usage_error` object ([protocol/headless.md](../protocol/headless.md)).
- argv is the only source: there is no environment variable. A restart re-execs with the same argv, so the mode survives it. Docker headless runs pass it as `UI=` ([docker/README.md](../../docker/README.md) → Headless runs).
- `createServer` throws on `uiMode: 'interact'` with no focus cell, so a wrong boot fails loudly.
- A replay under `--ui view` is **launchless** (starts no session, no plugin backend, no CLI probe); under `interact` / `full` it is a working conductor ([components/headless-replay.md](../components/headless-replay.md)).

`GET /api/health` advertises the mode as a top-level key, never inside `capabilities` ([protocol/rest.md](../protocol/rest.md)):

```json
{ "ok": true, "app": "code-conductor", "pid": 1, "bootId": "…",
  "capabilities": { "…": true },
  "uiMode": "full" | "view" | "interact",
  "focus": { "sessionId": "…" | null } }
```

- `uiMode` is always present; `focus` only on a headless run or replay.
- The client reads both through `loadCapabilities` (`shared/capabilities.ts`): `setFocus` first, then `setUiMode(uiModeFromHealth(body))`. A missing or unknown `uiMode` fails closed to `view`.
- Until health answers the client runs as `full`; a failed read leaves the mode unchanged.
- **The interactive session is the server's `focus.sessionId`, read through `serverFocus()`; a page's `?focus=<sid>` marker never makes a session interactive** ([conduct.md](conduct.md) → Focus from the URL). While it is `null` (a live run whose root has not spawned) nothing is interactive. The client re-reads the focus until it is set (`web/src/app/focus.ts`), and the interactive session follows it.

## What `view` removes

Controls are removed from the DOM, not disabled. `useViewOnly()` (`web/src/state/viewOnly.ts`) is the global gate (true under `view` and `interact`); `useSessionViewOnly(sessionId)` is the per-session gate (true under `view`, and under `interact` for every session but the interactive one).

- Sidebar: ⚙ Settings and **Conduct**. The `#settings` route renders the session view; `SettingsView`'s chunk is never loaded.
- Session view: the Composer (and the usage chip beside Send), and the empty state's **Start conducting** / **New project**.
- Session header: the permission-mode toggle, Sync, the crashed/exited Resume, and the whole ⋮ **Session actions** menu (its trigger is not rendered, so Summarize, Statistics, mid-turn statistics and per-session Mute are not offered either).
- Turn indicator: the Interrupt buttons; the "Working…" label stays.
- Plan and question cards still show their content (plan markdown, question text, option labels and descriptions); the approve/reject, feedback, option buttons, answer field and send are removed.
- Resume: `resumeSession` and a notification click (`resumeSessionByAnchor`) open the read-only Ended pane (`openEndedSession`) instead of `POST /api/instances`; the Ended pane's Resume button is hidden.

## What `interact` adds

On the focused root session only (`useSessionViewOnly`, `sessionViewOnly` in `shared/viewOnly.ts`), these come back:

- the Composer and its usage chip (an ended session's Composer stays read-only in every mode);
- the turn indicator's Interrupt / Interrupt now;
- the plan and question cards' controls (Approve sends the `mode` frame, then the prompt);
- the header's crashed/exited **Resume** (`POST /api/instances/:id/respawn`);
- the Ended pane's **Resume** (restore, then `POST /api/instances` with `resume`), and `resumeSession`. `resumeSessionByAnchor` resumes only on a user gesture; a page load still opens the Ended pane, so focus mode never auto-resumes.

Still hidden on every session: the permission-mode toggle, Sync, the ⋮ menu, the empty state's buttons, Settings and Conduct. Every other session — workers included, also ones the root spawns after boot — stays read-only.

## The backstop

Controls not hidden (project/worktree menus, the power menu, commit-history actions, rewind/fork, the Summary dialog's Generate/Ask) hit the two client chokepoints, which refuse whenever the mode is not `full`:

- `apiResponse` (`shared/http.ts`) throws `ViewOnlyError` before `fetch` unless `requestAllowed(method, url, body)` admits the call.
- `send()` (`shared/ws.ts`) writes nothing unless `frameAllowed(t, payload)` admits the frame; an `{ack:true}` send rejects with `ViewOnlyError`.

The lists, all in `shared/viewOnly.ts`, all **fail closed** (a route or frame not named is refused):

| List | Admitted | Mode |
|---|---|---|
| GET / HEAD | every read | `view`, `interact` |
| `VIEW_ONLY_REST_ALLOW` | the unread marker, read-aloud (`/api/tts`), a plugin view's lazy start | `view`, `interact` |
| `VIEW_ONLY_FRAMES_ALLOW` | subscriptions and pristine presence | `view`, `interact` |
| `INTERACT_FRAMES_ALLOW` | `prompt`, `interrupt`, `mode`, only when the payload's `id` is the interactive session's instance | `interact` |
| `INTERACT_REST_ALLOW` | `POST /api/instances` whose JSON body's `resume` is the interactive session (a fresh spawn or a non-JSON body is refused); `POST /api/instances/:id/respawn` of its instance; `POST …/sessions/:sid/restore` (both URL shapes) of it | `interact` |
| `INTERACT_REST_ANY` | `POST /api/transcribe` — the interactive Composer's dictation; persists nothing. The one interact entry that addresses no session. | `interact` |

- A frame names an instance, not a session: the web controller registers `setInstanceSessionLookup` (`startController`, `web/src/app/controller.ts`), mapping an instance id to its row's `sessionId`.
- `requestAllowed` reads a body only when it is a string.

## Refusal toast

Each refusal notifies `onViewOnlyRefusal`; `startViewOnlyNotice` (`web/src/app/viewOnlyNotice.ts`) shows one toast under a fixed id (`VIEW_ONLY_TOAST_ID`), so a burst reads as one. Its text is `VIEW_ONLY_MESSAGE`. A caller's own `toast.error(title, e.message)` for a refusal is dropped (`toast` in `web/src/ui/feedback.tsx` matches `VIEW_ONLY_MESSAGE`).

## Plugins

- Plugin views still load in every mode (`POST /api/plugins/:id/start` is allowed). A plugin page's own requests bypass both chokepoints.
- `ccBridge.sendPrompt` goes through `send('prompt')`: it answers result code `VIEW_ONLY` under `view`, and under `interact` for any session but the focused root, which it reaches ([plugins/runtime.md](../plugins/runtime.md)).
- A plugin reads `uiMode` and `focus.sessionId` from `/api/health` to hide its own controls ([plugin-ui.md](../plugin-ui.md#ui-modes)).
