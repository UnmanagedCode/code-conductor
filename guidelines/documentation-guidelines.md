## Documentation guidelines
Layer docs; on any behavior change, update the most specific file — not just the README.
- `docs/features.md` — user-facing features, UI, new tools.
- `docs/protocol.md` — interface contracts: endpoints, message types, protocol flags, wire formats.
- `docs/architecture.md` — internals: components, lifecycle, on-disk state, migrations, test patterns.
- `README.md` — overview, quick start, key defaults, known limitations; add a one-line note here only when a change adds a new top-level subsystem.
Be precise: name exact paths, commands, flags, and defaults; prefer bullets/tables over prose; keep functional and technical descriptions in sync.
