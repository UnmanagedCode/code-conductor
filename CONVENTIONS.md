<!-- cc:conventions design-guidelines,testing-guidelines,documentation-guidelines,migration-guidelines -->

## Design guidelines
- YAGNI — build only what a current, concrete requirement needs; no speculative abstractions, config knobs, or extension points "for later." If code isn't exercised by a real caller or test, delete it rather than keep it "just in case."
- One responsibility per module — when a module takes on a second concern, extract it as a composed collaborator behind a stable interface; no god-modules.
- Single source of truth — shared catalogs, config, and constants live in one authoritative place and are read from there; never duplicate them (a startup fallback is fine — it's a fallback, not a second source).
- Keep wiring thin — entry/bootstrap code builds state and calls each feature's init once; feature logic lives in its own module, not the entry point.
- Share one implementation across surfaces — when the same logic backs multiple interfaces (e.g. an HTTP API and a CLI/MCP tool), write it once and import it from both; never reimplement per surface.
- Depend on stable interfaces, not internals — collaborators talk through narrow, documented surfaces so either side can change independently.
- Fail loudly, not silently — surface errors with context; reserve fallbacks for genuine, logged degradations.

## Testing guidelines
- Prefer automated tests over manual verification checklists — write runnable proof, not a script to follow by hand.
- Tests must be deterministic and fast: no long real sleeps, no live network, no wall-clock dependence. Use short timeouts and fake/injected clocks, and assert on the killed/cancelled outcome rather than waiting out a delay.
- Isolate state: each test sets up and tears down its own fixtures (fresh temp dirs, no shared globals) so tests pass in any order.
- For expensive/external systems (a real CLI or API), build a small fake emitting canned output and inject it via env var; keep one real-dependency smoke test gated behind an env flag (e.g. `RUN_REAL_X=1`).
- Use the language's built-in test runner unless the project already uses another framework; avoid adding dependencies.
- When presenting an implementation plan, include an "Integration tests" section listing the actual test files, what they cover, and the run command — not a "Manual verification" section.
- Run tests as the last implementation step and report pass/fail; don't ask the user to verify by hand.

## Documentation guidelines
Layer docs; on any behavior change, update the most specific file(s) — not just the README.
- `docs/features.md` — user-facing features, UI, new tools.
- `docs/protocol.md` — interface contracts: endpoints, message types, protocol flags, wire formats.
- `docs/architecture.md` — internals: components, lifecycle, on-disk state, migrations, test patterns.
- `README.md` — overview, quick start, key defaults, known limitations; add a one-line note here only when a change adds a new top-level subsystem.
This overrides the workspace README-maintenance update rule here: README changes only for new top-level subsystems; new commands/flags/endpoints go to the matching `docs/*.md`.

## Migration guidelines
- When a persisted data or config format changes, write a one-shot, idempotent migration that runs at startup and upgrades old state in place — don't scatter format checks through application code.
- Application code assumes the current format only: no read-time dual-shape parsing, no legacy key aliases, no "back-compat" defaults.
- Migrations must self-check "already applied" and no-op if so; never destroy data you can't reconstruct — move it aside instead of deleting it.
- APIs with no external consumers owe no stability guarantee — change the API and its callers together instead of keeping an old shape alive "just in case."
- Exception: tolerate read-time variance only for formats owned by external tools you can't migrate (e.g. a third-party CLI's session files); everything you own gets migrated, not shimmed.
