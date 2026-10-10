# Captured raw reports for `tests/harness-mutation-suite.test.mjs`

Real runner output. The `pw-list-*` listings come from this repo's own config; the
rest were captured from throwaway tests that were never committed, in a scratch tree laid out like this repo (`web/vitest.config.ts` with `root` = `web/`
and `include: ['src/**/*.test.{ts,tsx}']`; `web/playwright.config.ts` with
`testDir: './e2e'` and projects `desktop`, `phone`) whose `node_modules` linked to
this repo's install. The absolute root (the scratch tree's, or this repo's) is rewritten to `/repo`
everywhere, and `node_modules` paths in stack traces to `/repo/node_modules`;
nothing else is edited.

| file | tool | command (cwd = scratch root) |
|---|---|---|
| `vitest-mixed.json` | vitest 5.0.3 | `NO_COLOR=1 npx vitest run --config web/vitest.config.ts --reporter=json --outputFile=<abs> web/src/logic.test.ts web/src/nested/load.test.ts` |
| `vitest-pass.json` | vitest 5.0.3 | same, with `web/src/pass.test.ts` |
| `pw-desktop-fail.json` | @playwright/test 1.64.0 | `PLAYWRIGHT_JSON_OUTPUT_FILE=<abs> NO_COLOR=1 npx playwright test --config web/playwright.config.ts --reporter=json --project=desktop web/e2e/mixed.spec.ts` |
| `pw-desktop-pass.json` | @playwright/test 1.64.0 | same, with `web/e2e/legacy/deep.spec.ts` |
| `pw-desktop-load.json` | @playwright/test 1.64.0 | same, with `web/e2e/load.spec.ts web/e2e/mixed.spec.ts` |
| `pw-list-selected.json` | @playwright/test 1.64.0 | in this repo: `PLAYWRIGHT_JSON_OUTPUT_FILE=<abs> NO_COLOR=1 npx playwright test --config web/playwright.config.ts --list --reporter=json --project=desktop web/e2e/switch.spec.ts` |
| `pw-list-not-selected.json` | @playwright/test 1.64.0 | same, with `--project=android` |
| `pw-list-load.json` | @playwright/test 1.64.0 | same, with `--project=desktop` and a throwaway `web/e2e/zz-load.spec.ts` that imports a missing module |

What the throwaway tests held:

- `web/src/logic.test.ts`: a passing top-level test; `outer > inner` with one failing and one passing test; a skipped test under `outer`.
- `web/src/logic.test.tsx`: one passing test. Not requested; the Vitest filter `web/src/logic.test.ts` matches it as a substring, so it is in `vitest-mixed.json`.
- `web/src/nested/load.test.ts`: imports a missing module, so the file fails to load (`status: "failed"`, no assertion results).
- `web/src/pass.test.ts`: one passing test.
- `web/e2e/mixed.spec.ts`: a passing and a failing top-level test; `outer > inner > deep fails`; a skipped test under `outer`.
- `web/e2e/legacy/deep.spec.ts`: one passing test in a subdirectory.
- `web/e2e/load.spec.ts`: imports a missing module. Playwright then reports the load error in `errors[]` and runs no file at all, `mixed.spec.ts` included.
