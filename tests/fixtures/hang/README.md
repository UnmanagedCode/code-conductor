Fixtures for the hang-guard regression suite (cards 2026-0190, 2026-0198).

The suite is the five `tests/hang-guard-*.test.mjs` files — `-file-kill`,
`-run-cap`, `-layer-b`, `-sweep`, `-stall` — over the shared harness in
`tests/hangGuardCase.mjs`. It was one file (`tests/hang-guard.test.mjs`) until
card 2026-0198 split it: each case's cost is its squeezed deadline rather than
work, so one file was charged the sum and five are charged the max.

Named `*.fixture.mjs`, NOT `*.test.mjs`, on purpose: `discover()` in
`tests/run.mjs` globs `*.test.mjs`, so these never join a normal suite run —
several of them hang or wedge by design. `runGuard()` in `hangGuardCase.mjs` runs
each by passing its explicit path to a child `tests/run.mjs`, which still
executes it.
