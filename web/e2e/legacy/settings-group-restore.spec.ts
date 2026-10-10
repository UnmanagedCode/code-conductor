// Settings group nav vs. shown group in the old UI after Chromium re-creates
// the page. Back after a cross-document navigation re-creates the document (the
// app's open WebSocket keeps it out of the back/forward cache), and Chromium
// restores a form control's value into it with no `change` event, after `load`
// and before `pageshow`. Each row asserts `#settings-group-select`'s value
// names the one `.settings-group` not hidden. The reload row is a control:
// Chromium restores no form state on reload. happy-dom does no form
// restoration, so the in-suite counterparts are the group-nav tests in
// tests/settings-toggle.test.mjs and the `autocomplete="off"` assertion in
// tests/static.test.mjs.
import type { Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures.ts';

type Nonced = { __ccNonce?: number };

test.use({ ccOptions: { server: 'settings-group-restore' }, viewport: { width: 1280, height: 800 } });

/** What the nav says vs. what the page shows. */
function readNav(page: Page) {
  return page.evaluate(() => ({
    selected: (document.getElementById('settings-group-select') as HTMLSelectElement).value,
    shown: [...document.querySelectorAll<HTMLElement>('.settings-group')]
      .filter(g => !g.hidden).map(g => g.id.replace(/^settings-/, '')),
  }));
}

async function expectNavAgrees(page: Page, label: string) {
  const nav = await readNav(page);
  expect.soft(nav.shown, `${label}: select=${nav.selected} shown=[${nav.shown.join(',')}]`).toEqual([nav.selected]);
}

async function openSettings(page: Page, group: string) {
  await page.goto('/legacy/#settings');
  await page.waitForSelector('#settings-view:not([hidden])');
  await page.selectOption('#settings-group-select', group);
}

/** A restore lands after `load`, before `pageshow`; read after the next task. */
async function settle(page: Page) {
  await page.waitForLoadState('load');
  await page.evaluate(() => new Promise(r => setTimeout(r, 100)));
}

// Leave for another document and come Back. The nonce is the positive control:
// a page served from the back/forward cache keeps it, and such a page is never
// re-created, so every row would read green whatever the fix does.
async function awayAndBack(page: Page, label: string) {
  await page.evaluate(() => { (window as Nonced).__ccNonce = 1; });
  await page.goto('/api/health');
  await page.goBack();
  await settle(page);
  const nonce = await page.evaluate(() => (window as Nonced).__ccNonce);
  expect.soft(nonce, `${label}: document re-created on Back, not served from bfcache (nonce=${nonce})`).toBeUndefined();
}

test('the Settings group select and the shown group agree after the page is re-created', async ({ page }) => {
  await test.step('Back onto #settings after picking voice', async () => {
    // Settings is already open when a restore would land.
    await openSettings(page, 'voice');
    await awayAndBack(page, 'Back onto #settings');
    await expectNavAgrees(page, 'Back onto #settings after picking voice');
  });

  await test.step('Back onto #x after picking about, then enter', async () => {
    // Entering Settings must find the select and the shown group agreeing,
    // whether or not the browser put a value back while Settings was closed.
    await openSettings(page, 'about');
    await page.evaluate(() => { location.hash = '#x'; });
    await awayAndBack(page, 'Back onto #x');
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    await expectNavAgrees(page, 'Back onto #x after picking about, then enter');
  });

  await test.step('reload on #settings after picking voice (control)', async () => {
    await openSettings(page, 'voice');
    await page.reload();
    await settle(page);
    await expectNavAgrees(page, 'reload on #settings after picking voice (control)');
  });
});
