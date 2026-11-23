# View-only mode

A spectator mode for watching cc (for example on a phone) without a stray tap changing anything. **A UX convenience, not access control**: cc has no auth, the server enforces nothing, and the REST API, `/mcp` and a plugin page's own requests stay open. Leaving view-only means restarting cc without the flag.

## Turning it on

- `CC_VIEW_ONLY=1` ([environment.md](../environment.md)), read by `entryStartOptions` (`server.ts`) and carried to `GET /api/health` as `capabilities.viewOnly: true`. The key is absent when the flag is unset; it is not a `Platform` capability ([components/platform.md](../components/platform.md#platform-capabilities)).
- The client reads it once through `loadCapabilities` (`shared/capabilities.ts`) → `setViewOnly`. Until `/api/health` answers, the client behaves as in normal mode; a failed read leaves the flag unchanged.

## What the UI removes

Controls are removed from the DOM (`useViewOnly`, `web/src/state/viewOnly.ts`), not disabled:

- Sidebar: ⚙ Settings and **Conduct**. The `#settings` route renders the session view; `SettingsView`'s chunk is never loaded.
- Session view: the Composer (and the usage chip beside Send), and the empty state's **Start conducting** / **New project**.
- Session header: the permission-mode toggle, Sync, Resume, and the mutating ⋮ items (rename, model, effort, prune, fork, auto-approve plans, enforce playbooks, debug capture, sync worktree, interrupt/terminate). Summarize, Statistics, mid-turn statistics and Mute stay.
- Turn indicator: the Interrupt buttons; the "Working…" label stays.
- Plan and question cards still show their content (plan markdown, question text, option labels and descriptions); the approve/reject, feedback, option buttons, answer field and send are removed.
- Resume: `resumeSession` and a notification click (`resumeSessionByAnchor`) open the read-only Ended pane (`openEndedSession`) instead of `POST /api/instances`; the Ended pane's Resume button is hidden.

## The backstop

Controls not hidden (project/worktree menus, the power menu, commit-history actions, rewind/fork, the Summary dialog's Generate/Ask) hit the two client chokepoints, which refuse while the flag is on:

- `apiResponse` (`shared/http.ts`) throws `ViewOnlyError` before `fetch` for any method outside GET/HEAD that `VIEW_ONLY_REST_ALLOW` does not name.
- `send()` (`shared/ws.ts`) writes nothing for a frame type outside `VIEW_ONLY_FRAMES_ALLOW`; an `{ack:true}` send rejects with `ViewOnlyError`.

Both allowlists are in `shared/viewOnly.ts` and **fail closed**: a new route or frame type is refused by default.

## Refusal toast

Each refusal notifies `onViewOnlyRefusal`; `startViewOnlyNotice` (`web/src/app/viewOnlyNotice.ts`) shows one toast under a fixed id (`VIEW_ONLY_TOAST_ID`), so a burst reads as one. A caller's own `toast.error(title, e.message)` for a refusal is dropped (`toast` in `web/src/ui/feedback.tsx` matches `VIEW_ONLY_MESSAGE`).

## Plugins

Plugin views still load (`POST /api/plugins/:id/start` is allowed). A plugin page's own requests bypass both chokepoints. `ccBridge.sendPrompt` is refused with result code `VIEW_ONLY` ([plugins/runtime.md](../plugins/runtime.md)); a plugin reads `capabilities.viewOnly` from `/api/health` to hide its own controls ([plugin-ui.md](../plugin-ui.md#view-only-hosts)).
