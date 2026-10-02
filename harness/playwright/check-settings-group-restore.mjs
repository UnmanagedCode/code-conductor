// Settings group nav vs. shown group after the browser re-creates the page,
// in real Chromium.
//
//   node harness/playwright/check-settings-group-restore.mjs
//
// Back after a cross-document navigation re-creates the document (the app's
// open WebSocket keeps it out of the back/forward cache), and Chromium restores
// a form control's value into it with no `change` event, after `load` and
// before `pageshow`. This check picks a non-default group, navigates away and
// back, and asserts `#settings-group-select`'s value names the one
// `.settings-group` not hidden. The reload rows are controls: Chromium restores
// no form state on reload. happy-dom does no form restoration, so the browser
// half lives here; the in-suite counterparts are tests/settings-toggle.test.mjs
// ("settings: install renders the markup-default group, …") and the
// `autocomplete="off"` assertion in tests/static.test.mjs. Exits non-zero on a
// mismatch.

import { bootOrch } from './boot-orch.mjs';
import { importCodePlaywright } from './paths.mjs';

const { withPage } = await importCodePlaywright();

const failures = [];

// What the nav says vs. what the page shows.
async function readNav(page) {
  return page.evaluate(() => ({
    selected: document.getElementById('settings-group-select').value,
    shown: [...document.querySelectorAll('.settings-group')]
      .filter(g => !g.hidden).map(g => g.id.replace(/^settings-/, '')),
  }));
}

function check(label, nav) {
  const ok = nav.shown.length === 1 && nav.shown[0] === nav.selected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: select=${nav.selected} shown=[${nav.shown.join(',')}]`);
  if (!ok) failures.push(label);
}

async function openSettings(page, url, group) {
  await page.goto(url + '/#settings');
  await page.waitForSelector('#settings-view:not([hidden])');
  await page.selectOption('#settings-group-select', group);
}

// A restore lands after `load`, before `pageshow`; read after the next task.
async function settle(page) {
  await page.waitForLoadState('load');
  await page.evaluate(() => new Promise(r => setTimeout(r, 100)));
}

// Leave for another document and come Back. The nonce is the positive control:
// a page served from the back/forward cache keeps it, and such a page is never
// re-created, so every row would read green whatever the fix does.
async function awayAndBack(page, url, label) {
  await page.evaluate(() => { window.__ccNonce = 1; });
  await page.goto(url + '/api/health');
  await page.goBack();
  await settle(page);
  const nonce = await page.evaluate(() => window.__ccNonce);
  const ok = nonce === undefined;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: document re-created on Back (nonce=${nonce})`);
  if (!ok) failures.push(`${label}: served from bfcache`);
}

const orch = await bootOrch({ sandbox: true });
try {
  await withPage(async (page) => {
    // Back onto #settings: Settings is already open when a restore would land.
    await openSettings(page, orch.url, 'voice');
    await awayAndBack(page, orch.url, 'Back onto #settings');
    check('Back onto #settings after picking voice', await readNav(page));

    // Back onto a non-settings hash, then enter Settings: the entry must find
    // the select and the shown group agreeing, whether or not the browser put
    // a value back into the select while Settings was closed.
    await openSettings(page, orch.url, 'about');
    await page.evaluate(() => { location.hash = '#x'; });
    await awayAndBack(page, orch.url, 'Back onto #x');
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    check('Back onto #x after picking about, then enter', await readNav(page));

    // Controls: a reload restores no form state.
    await openSettings(page, orch.url, 'voice');
    await page.reload();
    await settle(page);
    check('reload on #settings after picking voice (control)', await readNav(page));
  });
} finally {
  await orch.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
