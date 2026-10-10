// The test object every cc spec imports. `cc` is a WORKER fixture: one booted
// server per worker, and a spec file's `test.use({ ccOptions })` gets its own
// (Playwright starts a new worker when worker options differ). `baseURL` points
// at it, so `page.goto('/next/')` reaches this spec's server.

import { test as base } from '@playwright/test';
import { bootCc, type Cc, type CcOptions } from './boot.ts';

export { expect } from '@playwright/test';
export type { Cc, CcOptions } from './boot.ts';

export const test = base.extend<object, { ccOptions: CcOptions; cc: Cc }>({
  ccOptions: [{}, { scope: 'worker', option: true }],
  cc: [async ({ ccOptions }, use) => {
    const cc = await bootCc(ccOptions);
    try { await use(cc); } finally { await cc.close(); }
  }, { scope: 'worker' }],
  baseURL: async ({ cc }, use) => { await use(cc.url); },
});
