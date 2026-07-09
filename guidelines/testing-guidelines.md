## Testing guidelines
- Prefer automated tests over manual verification checklists — write runnable proof, not a script to follow by hand.
- Tests must be deterministic and fast: no long real sleeps, no live network, no wall-clock dependence. Use short timeouts and fake/injected clocks, and assert on the killed/cancelled outcome rather than waiting out a delay.
- Isolate state: each test sets up and tears down its own fixtures (fresh temp dirs, no shared globals) so tests pass in any order.
- For expensive/external systems (a real CLI or API), build a small fake emitting canned output and inject it via env var; keep one real-dependency smoke test gated behind an env flag (e.g. `RUN_REAL_X=1`).
- Use the language's built-in test runner unless the project already uses another framework; avoid adding dependencies.
- In plan files, use an "Integration tests" section listing the actual test files, what they cover, and the run command — not a "Manual verification" section.
- Run tests as the last implementation step and report pass/fail; don't ask the user to verify by hand.
