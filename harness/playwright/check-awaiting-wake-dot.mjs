// The awaiting-wake sidebar dot, in a real browser.
//
// Why this is here and not in tests/: `public/` gets no typecheck and the
// node:test suite never loads the render path, so the ONLY gate on the accent
// idle dot is a browser. It asserts the class AND the computed background colour
// — the class alone passes under a CSS rename, and the colour alone passes under
// a JS rename, so both halves are needed (both mutation-verified).
//
// The behaviour it covers has no other cover at all: `awaitingWake` is
// CALLER-side (`InstanceManager.list()` ← `isIdleCaller`), so the dot says "idle
// because I am waiting on a worker" rather than "idle because I am done" — and it
// must STAY lit across a heartbeat, because a heartbeat reports without consuming
// the wake. That last box is the one most likely to regress silently.
//
//   node harness/playwright/check-awaiting-wake-dot.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage } from '../../../code-playwright/browser.mjs';
import { bootOrch } from './boot-orch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One scenario drives BOTH sessions: the two WORKER-* prompts are long turns
// (delay_ms spaces every event), and the unfiltered turns behind them are what
// the conductor answers each wake stub with, so it returns to idle in ms.
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-awaiting-wake.json');
const HEARTBEAT_MS = 3000;

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

// Long enough that the conductor is back at idle well before the next ping, and
// short enough that one lands inside the worker's ~7s turn.
const results = [];
const box = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`); };

const orch = await bootOrch({
  sandbox: true,
  scenario: SCENARIO,
  env: { ORCH_SUBSCRIBE_TIMEOUT_MS: String(HEARTBEAT_MS) },
});
const base = orch.url;
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
let rpcId = 1;
const callTool = async (name, args, caller) => {
  const url = base + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  return j.result;
};

try {
  await api('POST', '/api/projects', { name: 'uipass' });
  const c = await api('POST', '/api/instances', { project: 'uipass', mode: 'bypassPermissions' });
  const insts = () => api('GET', '/api/instances');
  await waitFor(async () => (await insts()).body.find(i => i.id === c.body.id)?.status === 'idle');
  const condId = c.body.id;
  const condSid = (await insts()).body.find(i => i.id === condId).sessionId;

  // Spawn the worker THROUGH the conductor, so callerInstanceId is set and the
  // sidebar groups it as conducted (the real conduct-mode shape).
  const spawn = JSON.parse((await callTool('spawn_instance',
    { project: 'uipass', mode: 'bypassPermissions' }, condId)).content[0].text);
  const workerSid = spawn.sessionId;
  await waitFor(async () => (await insts()).body.find(i => i.sessionId === workerSid)?.status === 'idle');
  const workerId = (await insts()).body.find(i => i.sessionId === workerSid).id;

  const short = (sid) => sid.slice(0, 8);

  await withPage(async (page) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    // The dot state for one session row, read off the live DOM.
    // Rows carry their session on the <li>'s `_holder` (public/sidebar.js), which
    // is how we address the conductor's row rather than guessing from its text.
    const dotOf = (instanceId) => page.evaluate((id) => {
      for (const row of document.querySelectorAll('.session-row')) {
        const h = row.parentElement?._holder;
        if (h?.session?.instanceId !== id) continue;
        const dot = row.querySelector('.dot');
        if (dot) return { cls: dot.className, title: dot.title,
                          bg: getComputedStyle(dot).backgroundColor,
                          accent: getComputedStyle(document.documentElement)
                            .getPropertyValue('--accent').trim() };
      }
      return null;
    }, instanceId);

    await waitFor(async () => !!(await dotOf(condId)));

    // ---- BOX 0 (baseline): nothing armed, plain idle dot.
    const before = await dotOf(condId);
    box('baseline (nothing armed)', before.cls === 'dot idle' && before.title === 'idle',
      `class="${before.cls}" title="${before.title}" bg=${before.bg}`);

    // Drive the worker mid-turn FROM the conductor.
    await callTool('send_prompt', { sessionId: workerSid, text: 'WORKER-GO' }, condId);
    await waitFor(async () => (await insts()).body.find(i => i.id === workerId)?.status === 'turn');

    // ---- BOX 1: worker mid-turn ⇒ conductor row idle + accent dot + tooltip.
    const mid = await waitFor(async () => {
      const d = await dotOf(condId);
      return d && d.cls.includes('awaiting') ? d : false;
    }, { timeout: 8000 }).catch(async () => await dotOf(condId));
    box('Sidebar dot, worker mid-turn',
      mid.cls === 'dot idle awaiting' && mid.title === 'idle — waiting on a worker'
        && mid.bg !== before.bg,
      `class="${mid.cls}" title="${mid.title}" bg=${mid.bg} (plain idle was ${before.bg}, --accent ${mid.accent})`);

    // ---- BOX 2: across a heartbeat, the dot must STAY accent.
    const beatCount = async () => {
      const e = await api('GET', `/api/instances/${condId}/events`);
      return (e.body.events ?? []).filter(x => x.kind === 'user_echo'
        && typeof x.text === 'string' && x.text.includes('did NOT finish')).length;
    };
    await waitFor(async () => (await beatCount()) >= 1, { timeout: HEARTBEAT_MS * 3 });
    // The heartbeat WAKES the conductor, so it takes a turn of its own; sample once
    // it is back at idle, with its worker still mid-turn.
    await waitFor(async () => (await insts()).body.find(i => i.id === condId)?.status === 'idle');
    const beats = await beatCount();
    const workerStill = (await insts()).body.find(i => i.id === workerId)?.status;
    const afterBeat = await dotOf(condId);
    console.log(`   (worker status while sampling: ${workerStill})`);
    box('Sidebar dot, across a heartbeat',
      beats >= 1 && workerStill === 'turn' && afterBeat.cls === 'dot idle awaiting'
        && afterBeat.bg === mid.bg,
      `heartbeats=${beats} class="${afterBeat.cls}" title="${afterBeat.title}" bg=${afterBeat.bg}`);

    // ---- BOX 4: the wake-callback bubble (folded) renders collapsible.
    // Wait for the worker's turn to end and the completion wake to land.
    await waitFor(async () => (await insts()).body.find(i => i.id === workerId)?.status === 'idle',
      { timeout: 20000 });
    await waitFor(async () => {
      const e = await api('GET', `/api/instances/${condId}/events`);
      return (e.body.events ?? []).some(x => x.kind === 'user_echo'
        && typeof x.text === 'string' && x.text.includes('finished its turn'));
    }, { timeout: 20000 });

    // ---- BOX 3: after turn_end the dot drops to plain idle.
    await waitFor(async () => (await insts()).body.find(i => i.id === condId)?.status === 'idle');
    const done = await waitFor(async () => {
      const d = await dotOf(condId);
      return d && !d.cls.includes('awaiting') ? d : false;
    }, { timeout: 10000 }).catch(async () => await dotOf(condId));
    box('Sidebar dot, after turn_end',
      done.cls === 'dot idle' && done.title === 'idle' && done.bg === before.bg,
      `class="${done.cls}" title="${done.title}" bg=${done.bg}`);

    // Open the conductor's conversation and look for the wake bubble.
    await page.evaluate((id) => {
      for (const row of document.querySelectorAll('.session-row')) {
        if (row.parentElement?._holder?.session?.instanceId === id) { row.click(); return; }
      }
    }, condId);
    const bubble = await waitFor(async () => page.evaluate(() => {
      for (const b of document.querySelectorAll('.wake-callback')) {
        const t = b.textContent || '';
        if (!t.includes('finished its turn')) continue;
        return { cls: b.className, hasDetails: !!b.querySelector('details'),
                 badge: t.includes('\u{1F514}'), text: t.replace(/\s+/g, ' ').slice(0, 140) };
      }
      return null;
    }), { timeout: 25000 }).catch(() => null);
    box('Wake-callback bubble (folded, collapsible)',
      !!bubble && bubble.hasDetails && bubble.badge,
      bubble ? `class="${bubble.cls}" details=${bubble.hasDetails} badge=${bubble.badge} text="${bubble.text}"` : 'not found');

    const outArg = process.argv.indexOf('--out');
    const outDir = outArg > -1 ? process.argv[outArg + 1] : path.join(__dirname, 'screenshots');
    await page.screenshot({ path: path.join(outDir, 'awaiting-wake-conductor.png') }).catch(() => {});
  });

  // ---- BOX 5: list_sessions renders `awaiting-wake yes/no`.
  // Re-arm by driving the worker again, then read the conductor-facing text.
  await callTool('send_prompt', { sessionId: workerSid, text: 'WORKER-AGAIN' }, condId);
  await waitFor(async () => (await insts()).body.find(i => i.id === workerId)?.status === 'turn');
  const listed = (await callTool('list_sessions', { project: 'uipass' }, condId)).content[0].text;
  const yes = /awaiting-wake yes/.test(listed);
  const no = /awaiting-wake no/.test(listed);
  box('list_sessions text', yes && no,
    `awaiting-wake yes=${yes} no=${no}; sample=${(listed.match(/.*awaiting-wake.*/g) || []).join(' | ').slice(0, 200)}`);
  console.log('\nno "idle-sub" anywhere in the rendering:', !/idle-sub/.test(listed));
} finally {
  await orch.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} boxes green`);
process.exit(failed.length ? 1 : 0);
