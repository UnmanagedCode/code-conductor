# Captured raw reports for `tests/harness-mutation-parse.test.mjs`

Real runner output. These were captured from throwaway tests that were never committed, in a scratch tree laid out like this repo (`web/vitest.config.ts` with `root` = `web/`
and `include: ['src/**/*.test.{ts,tsx}']`; `web/playwright.config.ts` with
`testDir: './e2e'` and projects `desktop`, `phone`) whose `node_modules` linked to
this repo's install. The absolute root (the scratch tree's, or this repo's) is rewritten to `/repo`
everywhere, and `node_modules` paths in stack traces to `/repo/node_modules`;
nothing else is edited.

| file | tool | command (cwd = scratch root) |
|---|---|---|
| `pw-desktop-fail.json` | @playwright/test 1.64.0 | `PLAYWRIGHT_JSON_OUTPUT_FILE=<abs> NO_COLOR=1 npx playwright test --config web/playwright.config.ts --reporter=json --project=desktop web/e2e/mixed.spec.ts` |
| `pw-desktop-pass.json` | @playwright/test 1.64.0 | same, with `web/e2e/legacy/deep.spec.ts` |
| `pw-desktop-load.json` | @playwright/test 1.64.0 | same, with `web/e2e/load.spec.ts web/e2e/mixed.spec.ts` |

What the throwaway tests held:

- `web/e2e/mixed.spec.ts`: a passing and a failing top-level test; `outer > inner > deep fails`; a skipped test under `outer`.
- `web/e2e/legacy/deep.spec.ts`: one passing test in a subdirectory.
- `web/e2e/load.spec.ts`: imports a missing module. Playwright then reports the load error in `errors[]` and runs no file at all, `mixed.spec.ts` included.
