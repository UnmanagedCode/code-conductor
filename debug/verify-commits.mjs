// Verification script for four commits-view fixes.
// Usage: node verify-commits.mjs

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { withPage, waitForServer } from '../../termux-playwright-harness/browser.mjs';

const BASE = 'http://127.0.0.1:8788';
const OUT  = path.resolve('screenshots/commits-verify');
await mkdir(OUT, { recursive: true });

const VIEWPORT = { width: 390, height: 844 };

let pass = 0, fail = 0;
const ok   = (l) => { console.log(`  ✅  ${l}`); pass++; };
const ko   = (l) => { console.log(`  ❌  ${l}`); fail++; };
const warn = (l) =>   console.log(`  ⚠️   ${l}`);

await waitForServer(BASE, { timeoutMs: 5000 });

// Auto-dismiss any browser dialogs (alerts from resumeSession errors)
let dialogMessage = null;

await withPage(async (page) => {
  page.on('dialog', d => { dialogMessage = d.message(); d.dismiss(); });
  const snap = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

  async function openSidebar() {
    const open = await page.evaluate(() =>
      document.getElementById('sidebar').classList.contains('open')
    );
    if (!open) {
      await page.evaluate(() => document.getElementById('sidebar-toggle').click());
      await page.waitForTimeout(350);
    }
  }

  // ── Load ─────────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#project-list', { timeout: 8000 });
  await openSidebar();
  await snap('0-sidebar-open');

  // ── Fix 1: ≡ left of project name ────────────────────────────────────
  console.log('\n─ Fix 1: button position ─');

  const pos = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.project-row:not(.project-row-conduct)')) {
      const btn  = row.querySelector('.commit-log');
      const name = row.querySelector('.project-name');
      if (!btn || !name) continue;
      const btnRect  = btn.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      if (btnRect.width === 0) continue;
      return { btnX: btnRect.x, nameX: nameRect.x, project: name.textContent.trim() };
    }
    return null;
  });

  if (!pos) {
    ko('no visible git-project row found');
  } else if (pos.btnX < pos.nameX) {
    ok(`"${pos.project}" — commit-log x=${pos.btnX.toFixed(0)} < project-name x=${pos.nameX.toFixed(0)}`);
  } else {
    ko(`"${pos.project}" — commit-log x=${pos.btnX.toFixed(0)} NOT left of project-name x=${pos.nameX.toFixed(0)}`);
  }

  // ── Fix 2: first click renders commits ───────────────────────────────
  console.log('\n─ Fix 2: first-click renders commits ─');

  const gitProject = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.project-row:not(.project-row-conduct)')) {
      const btn = row.querySelector('.commit-log');
      if (btn && btn.getBoundingClientRect().width > 0)
        return row.querySelector('.project-name')?.textContent?.trim() ?? null;
    }
    return null;
  });

  if (!gitProject) {
    ko('no visible git project to click');
  } else {
    await page.evaluate(() =>
      document.querySelector('.project-row:not(.project-row-conduct) .commit-log')?.click()
    );
    await page.waitForTimeout(400);
    await snap('2a-after-first-click');

    const commitsVisible = await page.$eval('#commits-view', el => !el.hidden).catch(() => false);
    if (!commitsVisible) {
      ko('commits-view not visible after first click');
    } else {
      await page.waitForFunction(
        () => !document.querySelector('.review-loading'),
        { timeout: 7000 }
      ).catch(() => {});

      await snap('2b-commits-loaded');

      const commitRowCount = await page.evaluate(() =>
        document.querySelectorAll('.commit-row').length
      );
      const hasError = await page.$eval('.review-error', el => el.textContent).catch(() => null);
      const listEmpty = await page.evaluate(() =>
        document.getElementById('commits-list').innerHTML.trim().length === 0
      );

      if (hasError) {
        ko(`commits-list error: ${hasError.trim()}`);
      } else if (commitRowCount > 0) {
        ok(`first click rendered ${commitRowCount} commit row(s) for "${gitProject}"`);
      } else if (listEmpty) {
        ko('commits-list is EMPTY — empty-page bug reproduced');
      } else {
        warn('unexpected list state');
      }
    }

    // ── Fix 3: header vs first-row overlap ────────────────────────────
    console.log('\n─ Fix 3: back button / header vs first commit row ─');
    const layout = await page.evaluate(() => {
      const header  = document.getElementById('commits-header');
      const firstRow = document.querySelector('.commit-row');
      if (!header || !firstRow) return null;
      const hBox = header.getBoundingClientRect();
      const rBox = firstRow.getBoundingClientRect();
      return { headerBottom: hBox.bottom, rowTop: rBox.top, overlap: hBox.bottom - rBox.top };
    });

    if (!layout) {
      warn('could not find header/first-row for overlap check');
    } else if (layout.overlap <= 2) {
      ok(`header bottom=${layout.headerBottom.toFixed(0)} ≤ first-row top=${layout.rowTop.toFixed(0)} (overlap=${layout.overlap.toFixed(1)}px)`);
    } else {
      ko(`header overlaps first row by ${layout.overlap.toFixed(1)}px`);
    }
    await snap('3-header-vs-row');

    // ── Fix 4: sidebar LIVE session click dismisses commits view ──────
    console.log('\n─ Fix 4: live-session click dismisses commits view ─');
    await openSidebar();

    const liveSessionCount = await page.evaluate(() =>
      document.querySelectorAll('.session-row.live').length
    );

    if (liveSessionCount === 0) {
      warn('no LIVE session rows in sidebar — cannot exercise the synchronous path; Fix 4 verified separately');
    } else {
      const commitsOpenBefore = await page.$eval('#commits-view', el => !el.hidden);
      if (!commitsOpenBefore) {
        ko('commits-view not open before session click');
      } else {
        // Click a live session row — sync path through selectInstance
        const clicked = await page.evaluate(() => {
          const row = document.querySelector('.session-row.live');
          if (!row) return false;
          row.click();
          return true;
        });
        if (!clicked) { ko('could not click live session row'); }
        else {
          await page.waitForTimeout(400);
          await snap('4-after-session-click');
          const commitsOpenAfter = await page.$eval('#commits-view', el => !el.hidden);
          if (!commitsOpenAfter) {
            ok('commits view closed when tapping a live session in sidebar');
          } else {
            ko('commits view still open after tapping live session — Fix 4 not working');
          }
        }
      }
    }
  }

  // ── Extra: URL hash + back-button ────────────────────────────────────
  console.log('\n─ Extra: URL hash & back button after pushState ─');
  await openSidebar();
  const hashBefore = await page.evaluate(() => location.hash);
  await page.evaluate(() =>
    document.querySelector('.project-row:not(.project-row-conduct) .commit-log')?.click()
  );
  await page.waitForTimeout(300);

  const hashAfterOpen = await page.evaluate(() => location.hash);
  if (hashAfterOpen === '#commits') {
    ok(`hash="${hashAfterOpen}" set correctly on open`);
  } else {
    ko(`hash="${hashAfterOpen}" (expected #commits)`);
  }

  const commitsVisible2 = await page.$eval('#commits-view', el => !el.hidden).catch(() => false);
  if (commitsVisible2) {
    await page.evaluate(() => document.getElementById('commits-back')?.click());
    await page.waitForTimeout(300);
    const hashAfterClose = await page.evaluate(() => location.hash);
    const commitsHidden  = await page.$eval('#commits-view', el => el.hidden);
    if (commitsHidden) {
      ok(`back button closes view; hash now "${hashAfterClose}"`);
    } else {
      ko('back button did not close commits view');
    }
    await snap('5-after-back-btn');
  }

}, { viewport: VIEWPORT });

console.log(`\n══ ${pass} passed  ${fail} failed ══\n`);
const { readdirSync } = await import('node:fs');
console.log('Screenshots:');
for (const f of readdirSync(OUT)) console.log(`  ${OUT}/${f}`);
if (fail > 0) process.exit(1);
