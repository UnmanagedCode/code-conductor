// Plugin frontend keep-alive (`frontend.keepAlive`), in a real browser.
//
// Why this is here and not in tests/: the node:test suite runs happy-dom with
// `disableIframePageLoading`, so no frame document ever exists there. The
// suite pins the view logic (same frame node, `src` untouched, no /start);
// whether the hidden page keeps RUNNING is measured only here.
//
// Conditions: Playwright's Chromium launched headless by code-playwright's
// `launchBrowser` — so with Playwright's default launch flags, which include
// `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`
// and `--disable-backgrounding-occluded-windows` — one visible top-level tab,
// `--use-fake-device-for-media-stream`
// + `--use-fake-ui-for-media-stream` and a granted `microphone` permission (the
// fake device plays a tone, so the analyser reads a non-zero RMS). The printed
// `[browser]` line names the version. A backgrounded tab — the whole page
// hidden — is outside what this measures.
//
// Three parts, each printing PASS / FAIL / SKIP lines:
//   A. raw  — the browser property alone, host-independent: the plain control
//             plugin's frame under `#plugin-view[hidden]` (display:none), with
//             the view's own teardown never running.
//   B. keep — the keep-alive fixture through the real exits (a Settings
//             supersede, the switcher's Conductor entry) and re-entry through
//             the switcher: same page load (nonce), counters continuous.
//             SKIP when the host does not report `frontendKeepAlive` on the row.
//   C. control — the same round trip on a plugin without `keepAlive` must
//             reload the page (new nonce): proves B's nonce check can fail.
//
// Per hidden interval of H seconds, gated: interval ticks ≥ 80% of H/100ms,
// WebSocket messages ≥ 80% of H/200ms, the mic track `live`, the AudioContext
// `running`, its currentTime advanced ≥ 0.9·H, non-zero RMS samples advanced.
// requestAnimationFrame callbacks are reported, not gated.
//
//   node harness/playwright/check-plugin-keepalive.mjs [--hold <seconds>]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootOrch } from './boot-orch.mjs';
import { importCodePlaywright } from './paths.mjs';

const { withPage } = await importCodePlaywright();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'keepalive-plugin');
const KEEP = 'keepalive-plugin';
const CONTROL = 'keepalive-control';

const holdArg = process.argv.indexOf('--hold');
const HOLD_S = holdArg > -1 ? Number(process.argv[holdArg + 1]) : 5;
if (!(HOLD_S > 0)) throw new Error('--hold needs a positive number of seconds');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

const results = [];
const box = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`);
};

const orch = await bootOrch({ sandbox: true });
const base = orch.url;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

// One project per plugin, adopted in place under the sandbox's projects root.
async function installPlugin(name, patch) {
  const dir = path.join(orch.sandbox.dirs.PROJECTS_ROOT, name);
  await fs.cp(FIXTURE, dir, { recursive: true });
  const mfPath = path.join(dir, 'conductor.plugin.json');
  const mf = JSON.parse(await fs.readFile(mfPath, 'utf8'));
  patch?.(mf);
  await fs.writeFile(mfPath, JSON.stringify(mf, null, 2));
  const r = await api('POST', '/api/projects/external', { name, path: dir });
  if (!r.body?.ok) throw new Error(`adopt ${name}: ${JSON.stringify(r.body)}`);
}

try {
  await installPlugin(KEEP);
  await installPlugin(CONTROL, (mf) => {
    mf.id = CONTROL;
    mf.name = 'Keep-alive control';
    mf.frontend = { navLabel: 'Keep-alive control' };
  });
  await api('POST', '/api/plugins/rescan');
  for (const id of [KEEP, CONTROL]) await api('POST', `/api/plugins/${id}/enable`);
  const rows = (await api('GET', '/api/plugins')).body.rows;
  const keepRow = rows.find(r => r.id === KEEP);
  const controlRow = rows.find(r => r.id === CONTROL);
  if (!controlRow?.enabled) throw new Error(`control plugin not enabled: ${JSON.stringify(controlRow)}`);

  await withPage(async (page, { browser, context }) => {
    console.log(`[browser] Chromium ${browser.version()}, headless, hold ${HOLD_S}s`);
    await context.grantPermissions(['microphone'], { origin: base });
    await page.goto(base, { waitUntil: 'networkidle' });

    const frameOf = (id) => page.frames().find(f => {
      try { return new URL(f.url()).pathname.startsWith(`/plugins/${id}/`); } catch { return false; }
    });
    const read = async (id) => {
      const f = frameOf(id);
      if (!f) return null;
      return f.evaluate(() => JSON.parse(JSON.stringify(window.__probe ?? null)));
    };
    const viewHidden = () => page.evaluate(() => document.getElementById('plugin-view').hidden);
    const enter = async (id) => {
      await page.selectOption('#app-switcher-select', id);
      await waitFor(async () => !(await viewHidden()) && (await read(id))?.nonce);
    };
    const startMic = async (id) => {
      await frameOf(id).click('#start');
      await waitFor(async () => {
        const p = await read(id);
        return p?.mic?.polls > 2 && p.mic.rmsNonZero > 0 && p.ws > 2;
      });
    };
    // Frames are read without re-showing the view, so what is measured is the
    // hidden interval itself.
    const gate = (label, a, b, ms) => {
      const d = (k) => b[k] - a[k];
      const s = ms / 1000;
      const checks = [
        ['interval ticks', d('ticks') >= 0.8 * ms / 100, `${d('ticks')} (expected ~${Math.round(ms / 100)})`],
        ['WebSocket messages', d('ws') >= 0.8 * ms / 200, `${d('ws')} (expected ~${Math.round(ms / 200)})`],
        ['mic track', b.mic?.readyState === 'live', `readyState=${b.mic?.readyState}`],
        ['AudioContext', b.mic?.ctxState === 'running', `state=${b.mic?.ctxState}`],
        ['AudioContext clock', b.mic.currentTime - a.mic.currentTime >= 0.9 * s,
          `+${(b.mic.currentTime - a.mic.currentTime).toFixed(2)}s over ${s.toFixed(2)}s`],
        ['mic samples', b.mic.rmsNonZero > a.mic.rmsNonZero, `non-zero RMS polls +${b.mic.rmsNonZero - a.mic.rmsNonZero}`],
      ];
      for (const [what, ok, detail] of checks) box(`${label} — ${what}`, ok, detail);
      console.log(`   (${label}: requestAnimationFrame callbacks +${d('raf')}, reported not gated)`);
    };
    const hold = async (id, label, hideFn) => {
      const a = await read(id);
      const t0 = Date.now();
      await hideFn();
      if (!(await viewHidden())) throw new Error(`${label}: #plugin-view still visible`);
      await sleep(HOLD_S * 1000);
      const b = await read(id);
      const ms = Date.now() - t0;
      if (!b) { box(`${label} — frame`, false, 'the plugin frame is gone'); return null; }
      if (b.nonce !== a.nonce) { box(`${label} — same page`, false, `nonce ${a.nonce} → ${b.nonce}`); return null; }
      gate(label, a, b, ms);
      return { a, b };
    };

    // ---- A. The raw browser property: hide the section, never tear down.
    await enter(CONTROL);
    await startMic(CONTROL);
    await hold(CONTROL, 'A raw hidden frame', () => page.evaluate(() => {
      document.getElementById('plugin-view').hidden = true;
    }));
    const display = await page.evaluate(() => {
      const d = getComputedStyle(document.getElementById('plugin-view')).display;
      document.getElementById('plugin-view').hidden = false;
      return d;
    });
    box('A raw hidden frame — display', display === 'none', `#plugin-view computed display=${display} while hidden`);

    // ---- B. keep-alive through the real exits.
    if (keepRow?.frontendKeepAlive !== true) {
      box('B keep-alive', null, `host does not report frontendKeepAlive on the row (state=${keepRow?.state}, errors=${JSON.stringify(keepRow?.errors)})`);
    } else {
      await enter(KEEP);
      await startMic(KEEP);
      const first = await read(KEEP);
      await hold(KEEP, 'B supersede by #settings', () => page.evaluate(() => { location.hash = '#settings'; })
        .then(() => waitFor(() => page.evaluate(() => !document.getElementById('settings-view').hidden))));
      await enter(KEEP);
      const back1 = await read(KEEP);
      box('B re-entry after #settings — same page', back1.nonce === first.nonce, `nonce ${first.nonce} → ${back1.nonce}`);
      await hold(KEEP, 'B leave by switcher Conductor', () => page.selectOption('#app-switcher-select', 'conductor')
        .then(() => waitFor(viewHidden)));
      await enter(KEEP);
      const back2 = await read(KEEP);
      box('B re-entry after Conductor — same page', back2.nonce === first.nonce, `nonce ${first.nonce} → ${back2.nonce}`);
      box('B re-entry — counters continuous', back2.ticks > back1.ticks && back2.ws > back1.ws && back2.mic.readyState === 'live',
        `ticks ${back1.ticks} → ${back2.ticks}, ws ${back1.ws} → ${back2.ws}, mic ${back2.mic.readyState}`);
      const marker = await page.evaluate((id) => {
        const opt = document.querySelector(`#app-switcher-select option[value="${id}"]`);
        return opt?.textContent ?? null;
      }, KEEP);
      box('B switcher marks the resident plugin', / \(running\)$/.test(marker ?? ''), JSON.stringify(marker));
    }

    // ---- C. Control: without keepAlive the same round trip reloads the page.
    await enter(CONTROL);
    const c0 = await read(CONTROL);
    await page.evaluate(() => { location.hash = '#settings'; });
    await waitFor(viewHidden);
    await enter(CONTROL);
    const c1 = await read(CONTROL);
    box('C control (no keepAlive) — reloads on re-entry', c1.nonce !== c0.nonce, `nonce ${c0.nonce} → ${c1.nonce}`);
  }, { extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
} finally {
  await orch.close();
}

const failed = results.filter(r => r.ok === false);
console.log(`\n${results.filter(r => r.ok).length} passed, ${failed.length} failed, ${results.filter(r => r.ok === null).length} skipped`);
process.exit(failed.length ? 1 : 0);
