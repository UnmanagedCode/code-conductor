Fixtures for `tests/hang-guard.test.mjs` (card 2026-0190).

Named `*.fixture.mjs`, NOT `*.test.mjs`, on purpose: `discover()` in
`tests/run.mjs` globs `*.test.mjs`, so these never join a normal suite run —
several of them hang or wedge by design. `hang-guard.test.mjs` runs each by
passing its explicit path to a child `tests/run.mjs`, which still executes it.
