// Plugin frontend keep-alive (`frontend.keepAlive`) in the old UI, in a real
// browser.
//
// Why a browser: the node:test suite runs happy-dom with
// `disableIframePageLoading`, so no frame document ever exists there. The
// suite pins the view logic (same frame node, `src` untouched, no /start);
// whether the hidden page keeps RUNNING is measured only here.
//
// Conditions: Playwright's headless Chromium with its default launch flags,
// which include `--disable-background-timer-throttling`,
// `--disable-renderer-backgrounding` and
// `--disable-backgrounding-occluded-windows` — one visible top-level tab,
// `--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream` and a
// granted `microphone` permission (the fake device plays a tone, so the
// analyser reads a non-zero RMS). The `browser` annotation names the version. A
// backgrounded tab — the whole page hidden — is outside what this measures.
//
// Three parts, sharing one page in order:
//   A. raw  — the browser property alone, host-independent: the plain control
//             plugin's frame under `#plugin-view[hidden]` (display:none), with
//             the view's own teardown never running.
//   B. keep — the keep-alive fixture through the real exits (a Settings
//             supersede, the switcher's Conductor entry) and re-entry through
//             the switcher: same page load (nonce), counters continuous.
//             Skipped when the host does not report `frontendKeepAlive` on the row.
//   C. control — the same round trip on a plugin without `keepAlive` must
//             reload the page (new nonce): proves B's nonce check can fail.
//
// Per hidden interval of H seconds, gated: interval ticks ≥ 80% of H/100ms,
// WebSocket messages ≥ 80% of H/200ms, the mic track `live`, the AudioContext
// `running`, its currentTime advanced ≥ 0.9·H, non-zero RMS samples advanced.
// requestAnimationFrame callbacks are reported (a `raf` annotation), not gated.
//
// H is `CC_E2E_KEEPALIVE_HOLD_S` (default 5). `CC_E2E_KEEPALIVE_HOLD_S=330`
// measures that the frame stays live for 330 s under a `display: none` ancestor
// with the flags above on; it says nothing about Chrome's default throttling
// policy.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Frame, Page } from '@playwright/test';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api } from '../harness/api.ts';
import { FIXTURES } from '../harness/boot.ts';

const FIXTURE = path.join(FIXTURES, 'keepalive-plugin');
const KEEP = 'keepalive-plugin';
const CONTROL = 'keepalive-control';

const HOLD_S = Number(process.env.CC_E2E_KEEPALIVE_HOLD_S ?? 5);
if (!(HOLD_S > 0)) throw new Error('CC_E2E_KEEPALIVE_HOLD_S needs a positive number of seconds');
const HOLD_MS = HOLD_S * 1000;

test.use({
  ccOptions: { server: 'plugin-keepalive' },
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
// B holds twice; every test also spends up to 20 s per frame wait.
test.describe.configure({ mode: 'serial', timeout: 120_000 + 2 * HOLD_MS });

type Mic = { readyState: string; ctxState: string; currentTime: number; rmsNonZero: number; polls: number };
type Probe = { nonce: string; ticks: number; ws: number; raf: number; mic: Mic | null };
type PluginRow = { id: string; enabled?: boolean; frontendKeepAlive?: boolean; state?: string; errors?: unknown };

/** One project per plugin, adopted in place under the projects root. */
async function installPlugin(cc: Cc, name: string, patch?: (mf: Record<string, unknown>) => void): Promise<void> {
  const dir = path.join(cc.dirs.projects, name);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const mfPath = path.join(dir, 'conductor.plugin.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  patch?.(mf);
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  const r = await api(cc, 'POST', '/api/projects/external', { name, path: dir });
  expect(r.body?.ok, `adopt ${name}: ${JSON.stringify(r.body)}`).toBeTruthy();
}

/** Polls `fn` every 100 ms until it is truthy; a throw (a frame mid-navigation) counts as not yet. */
const until = (fn: () => Promise<unknown>, timeout = 20_000) =>
  expect.poll(async () => { try { return !!(await fn()); } catch { return false; } }, { timeout, intervals: [100] }).toBe(true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let context: BrowserContext;
let page: Page;
let keepRow: PluginRow | undefined;

test.beforeAll(async ({ browser, cc }, testInfo) => {
  await installPlugin(cc, KEEP);
  await installPlugin(cc, CONTROL, (mf) => {
    mf.id = CONTROL;
    mf.name = 'Keep-alive control';
    mf.frontend = { navLabel: 'Keep-alive control' };
  });
  await api(cc, 'POST', '/api/plugins/rescan');
  for (const id of [KEEP, CONTROL]) await api(cc, 'POST', `/api/plugins/${id}/enable`);
  const rows = (await api<{ rows: PluginRow[] }>(cc, 'GET', '/api/plugins')).body.rows;
  keepRow = rows.find((r) => r.id === KEEP);
  const controlRow = rows.find((r) => r.id === CONTROL);
  expect(controlRow?.enabled, `control plugin not enabled: ${JSON.stringify(controlRow)}`).toBe(true);

  testInfo.annotations.push({ type: 'browser', description: `Chromium ${browser.version()}, headless, hold ${HOLD_S}s` });
  // One page shared by A, B and C, in a plain 1280×800 context (no device emulation).
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, baseURL: cc.url });
  await context.grantPermissions(['microphone'], { origin: cc.url });
  page = await context.newPage();
  await page.goto('/legacy/', { waitUntil: 'networkidle' });
});

test.afterAll(async () => { await context?.close(); });

const frameOf = (id: string): Frame | undefined => page.frames().find((f) => {
  try { return new URL(f.url()).pathname.startsWith(`/plugins/${id}/`); } catch { return false; }
});
/** The probe of `id`'s frame, read without re-showing the view. */
const read = async (id: string): Promise<Probe | null> => {
  const f = frameOf(id);
  if (!f) return null;
  return f.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __probe?: Probe }).__probe ?? null)));
};
const viewHidden = () => page.evaluate(() => document.getElementById('plugin-view')!.hidden);
const enter = async (id: string) => {
  await page.selectOption('#app-switcher-select', id);
  await until(async () => !(await viewHidden()) && (await read(id))?.nonce);
};
const startMic = async (id: string) => {
  await frameOf(id)!.click('#start');
  await until(async () => {
    const p = await read(id);
    return !!p?.mic && p.mic.polls > 2 && p.mic.rmsNonZero > 0 && p.ws > 2;
  });
};

/** The per-interval gates; each is its own soft assertion so one red names every other result too. */
function gate(label: string, a: Probe, b: Probe, ms: number): void {
  const d = (k: 'ticks' | 'ws' | 'raf') => b[k] - a[k];
  const s = ms / 1000;
  expect.soft(d('ticks'), `${label} — interval ticks (expected ~${Math.round(ms / 100)})`).toBeGreaterThanOrEqual(0.8 * ms / 100);
  expect.soft(d('ws'), `${label} — WebSocket messages (expected ~${Math.round(ms / 200)})`).toBeGreaterThanOrEqual(0.8 * ms / 200);
  expect.soft(b.mic?.readyState, `${label} — mic track`).toBe('live');
  expect.soft(b.mic?.ctxState, `${label} — AudioContext`).toBe('running');
  expect.soft(b.mic!.currentTime - a.mic!.currentTime, `${label} — AudioContext clock over ${s.toFixed(2)}s`)
    .toBeGreaterThanOrEqual(0.9 * s);
  expect.soft(b.mic!.rmsNonZero, `${label} — mic samples (non-zero RMS polls advance)`).toBeGreaterThan(a.mic!.rmsNonZero);
  const raf = `${label}: requestAnimationFrame callbacks +${d('raf')}, reported not gated`;
  test.info().annotations.push({ type: 'raf', description: raf });
  console.log(`   (${raf})`);
}

/** Hides the view with `hideFn`, holds HOLD_S, then gates what the hidden frame did meanwhile. */
async function hold(id: string, label: string, hideFn: () => Promise<unknown>): Promise<void> {
  const a = await read(id);
  expect(a?.mic, `${label}: the frame is running with its mic started`).toBeTruthy();
  const t0 = Date.now();
  await hideFn();
  expect(await viewHidden(), `${label}: #plugin-view still visible`).toBe(true);
  await sleep(HOLD_MS);
  const b = await read(id);
  const ms = Date.now() - t0;
  expect(b, `${label} — frame: the plugin frame is gone`).not.toBeNull();
  expect(b!.nonce, `${label} — same page`).toBe(a!.nonce);
  gate(label, a!, b!, ms);
}

test('A: a plugin frame under a display:none #plugin-view keeps running', async () => {
  await enter(CONTROL);
  await startMic(CONTROL);
  await test.step('A raw hidden frame — the hidden interval', () => hold(CONTROL, 'A raw hidden frame', () => page.evaluate(() => {
    document.getElementById('plugin-view')!.hidden = true;
  })));
  await test.step('A raw hidden frame — display', async () => {
    const display = await page.evaluate(() => {
      const d = getComputedStyle(document.getElementById('plugin-view')!).display;
      document.getElementById('plugin-view')!.hidden = false;
      return d;
    });
    expect(display, '#plugin-view computed display while hidden').toBe('none');
  });
});

test('B: a keepAlive plugin survives the real exits and re-enters the same page load', async () => {
  test.skip(keepRow?.frontendKeepAlive !== true,
    `host does not report frontendKeepAlive on the row (state=${keepRow?.state}, errors=${JSON.stringify(keepRow?.errors)})`);
  await enter(KEEP);
  await startMic(KEEP);
  const first = (await read(KEEP))!;

  await test.step('B supersede by #settings — the hidden interval', () => hold(KEEP, 'B supersede by #settings', () => page.evaluate(() => { location.hash = '#settings'; })
    .then(() => until(() => page.evaluate(() => !document.getElementById('settings-view')!.hidden)))));
  await enter(KEEP);
  const back1 = (await read(KEEP))!;
  await test.step('B re-entry after #settings — same page', () => {
    expect(back1.nonce, `nonce ${first.nonce} → ${back1.nonce}`).toBe(first.nonce);
  });

  await test.step('B leave by switcher Conductor — the hidden interval', () => hold(KEEP, 'B leave by switcher Conductor', () => page.selectOption('#app-switcher-select', 'conductor')
    .then(() => until(viewHidden))));
  await enter(KEEP);
  const back2 = (await read(KEEP))!;
  await test.step('B re-entry after Conductor — same page', () => {
    expect(back2.nonce, `nonce ${first.nonce} → ${back2.nonce}`).toBe(first.nonce);
  });
  await test.step('B re-entry — counters continuous', () => {
    const detail = `ticks ${back1.ticks} → ${back2.ticks}, ws ${back1.ws} → ${back2.ws}, mic ${back2.mic?.readyState}`;
    expect(back2.ticks, detail).toBeGreaterThan(back1.ticks);
    expect(back2.ws, detail).toBeGreaterThan(back1.ws);
    expect(back2.mic?.readyState, detail).toBe('live');
  });
  await test.step('B switcher marks the resident plugin', async () => {
    const marker = await page.evaluate((id) => {
      const opt = document.querySelector(`#app-switcher-select option[value="${id}"]`);
      return opt?.textContent ?? null;
    }, KEEP);
    expect(marker ?? '').toMatch(/ \(running\)$/);
  });
});

test('C: control — without keepAlive the same round trip reloads the page', async () => {
  await enter(CONTROL);
  const c0 = (await read(CONTROL))!;
  await page.evaluate(() => { location.hash = '#settings'; });
  await until(viewHidden);
  await enter(CONTROL);
  const c1 = (await read(CONTROL))!;
  expect(c1.nonce, `C control (no keepAlive) — reloads on re-entry: nonce ${c0.nonce} → ${c1.nonce}`).not.toBe(c0.nonce);
});
