@../CLAUDE.md

## Exploring this repo

Always read `README.md` at the project root before exploring the codebase. It has up-to-date functional and technical overviews (project list behavior, worktree layout, server architecture, etc.) and will usually answer orientation questions without needing to grep the source.

When `README.md` doesn't go deep enough, load the relevant detail file:
- **Feature / UI behavior** → `docs/features.md`
- **Subprocess protocol, WebSocket messages, REST endpoints** → `docs/protocol.md`
- **Component layout, instance lifecycle, on-disk state, migrations, testing** → `docs/architecture.md`

## Documentation updates

When a turn meaningfully changes user-facing behavior, update the **correct detail file** — not just the README:

| Change type | File to update |
|---|---|
| New/changed UI element, feature behavior, MCP tool | `docs/features.md` + one-liner summary in `README.md` if it adds a new top-level subsystem |
| Subprocess protocol flag, WebSocket message type, REST endpoint | `docs/protocol.md` |
| New source file, component wiring, lifecycle change, on-disk layout, migration, test pattern | `docs/architecture.md` |
| Quick start step, key default, known limitation | `README.md` directly |

## Testing

Prefer **automated integration tests** over manual verification checklists when shipping a feature. Write runnable proof, not a script for the user to follow by hand.

- In plan files, use an "Integration tests" section listing the actual test files, what they cover, and the command to run them (e.g. `node tests/run.mjs`) — not a "Manual verification" section.
- Use Node's built-in `node:test` + `node:assert` runner unless a project already uses another framework — no extra deps on Termux.
- For tests that would otherwise hit expensive/external systems (e.g. the real `claude` CLI), build a small fake binary (a Node script emitting canned stream-json) and inject it via env var (e.g. `CLAUDE_BIN`). Keep one real-binary smoke test if practical, but gate it behind an env flag (e.g. `RUN_REAL_CLAUDE=1`).
- Run tests as the last implementation step and report pass/fail, rather than asking the user to click through the UI.
