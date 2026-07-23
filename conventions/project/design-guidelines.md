## Design guidelines
- YAGNI — build only what a current, concrete requirement needs; no speculative abstractions, config knobs, or extension points "for later." If code isn't exercised by a real caller or test, delete it rather than keep it "just in case."
- One responsibility per module — when a module takes on a second concern, extract it as a composed collaborator behind a stable interface; no god-modules.
- Single source of truth — shared catalogs, config, and constants live in one authoritative place and are read from there; never duplicate them (a startup fallback is fine — it's a fallback, not a second source).
- Keep wiring thin — entry/bootstrap code builds state and calls each feature's init once; feature logic lives in its own module, not the entry point.
- Share one implementation across surfaces — when the same logic backs multiple interfaces (e.g. an HTTP API and a CLI/MCP tool), write it once and import it from both; never reimplement per surface.
- Depend on stable interfaces, not internals — collaborators talk through narrow, documented surfaces so either side can change independently.
- Fail loudly, not silently — surface errors with context; reserve fallbacks for genuine, logged degradations.
