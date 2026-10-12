// The test object every flow spec imports: the harness's `test` plus `ui`, the
// web UI's driver, and `uniq`, a name unique to this project (every spec file
// shares one cc across the desktop, phone and android projects).
import { test as base } from '../harness/fixtures.ts';
import { next, type Ui } from './ui.ts';

export const test = base.extend<{ ui: Ui; uniq: (s: string) => string }>({
  ui: async ({}, use) => { await use(next); },
  uniq: async ({}, use, testInfo) => { await use((s) => `${s}-${testInfo.project.name}`); },
});

export { expect } from '../harness/fixtures.ts';
export type { Cc } from '../harness/fixtures.ts';
