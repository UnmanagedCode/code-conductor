// Screenshot CLI: opens a URL in Playwright's headless Chromium and saves a
// PNG, or boots a scratch cc (fake CLI), snaps it and tears it down.
//
//   node web/e2e/harness/snap.ts <url> <out.png>
//   node web/e2e/harness/snap.ts --boot <out.png>     (snaps <scratch cc>/next/)
//
//   SNAP_VIEWPORT   "<w>x<h>" (default 1280x800)
//   SNAP_WAIT       CSS selector to wait for before the shot
//   SNAP_FULL_PAGE  "1" to capture the full scroll height

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { bootCc, type Cc } from './boot.ts';
import globalSetup from './global-setup.ts';

const args = process.argv.slice(2);
const boot = args[0] === '--boot';
if (boot) args.shift();
const [target, outArg] = boot ? [null, args[0]] : args;
if ((!boot && !target) || !outArg) {
  console.error('usage: node web/e2e/harness/snap.ts <url> <out.png>\n       node web/e2e/harness/snap.ts --boot <out.png>');
  process.exit(2);
}

const viewport = (() => {
  const v = process.env.SNAP_VIEWPORT;
  if (!v) return { width: 1280, height: 800 };
  const m = /^(\d+)x(\d+)$/.exec(v);
  if (!m) throw new Error(`SNAP_VIEWPORT must be <w>x<h>, got ${v}`);
  return { width: Number(m[1]), height: Number(m[2]) };
})();

const out = path.resolve(outArg);
fs.mkdirSync(path.dirname(out), { recursive: true });

let cc: Cc | null = null;
try {
  let url = target!;
  if (boot) {
    await globalSetup();
    cc = await bootCc();
    url = `${cc.url}/next/`;
    console.error(`[boot] ${cc.url}`);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle' });
    if (process.env.SNAP_WAIT) await page.waitForSelector(process.env.SNAP_WAIT, { timeout: 10_000 });
    await page.screenshot({ path: out, fullPage: process.env.SNAP_FULL_PAGE === '1' });
    console.log(out);
  } finally {
    await browser.close();
  }
} finally {
  if (cc) await cc.close();
}
