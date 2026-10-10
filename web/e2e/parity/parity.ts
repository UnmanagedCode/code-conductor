// Registers one parity scenario: the same behaviour, driven through each UI's
// own driver, as `<title> > legacy` and `<title> > next`. The ledger row it
// proves is named by `rowId` (checked by web/src/parity/ledger.test.ts).
import type { Page } from '@playwright/test';
import { test, type Cc } from '../harness/fixtures.ts';
import { UIS, type Ui } from './ui.ts';
import { UI_NAMES } from './uis.ts';

export type ParityArgs = {
  page: Page;
  cc: Cc;
  ui: Ui;
  /** A name unique to this UI and project: every parity file shares one cc. */
  uniq: (s: string) => string;
};

export function parity(rowId: string, title: string, body: (a: ParityArgs) => Promise<void>): void {
  test.describe(title, () => {
    for (const name of UI_NAMES) {
      test(name, { annotation: { type: 'ledger-row', description: rowId } }, async ({ page, cc }, testInfo) => {
        const ui = UIS[name];
        await body({ page, cc, ui, uniq: (s) => `${s}-${ui.name}-${testInfo.project.name}` });
      });
    }
  });
}
