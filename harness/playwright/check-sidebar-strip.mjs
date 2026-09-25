// The sidebar's needs-you strip and the waiting-on-you ring, in a real
// browser: rendered boxes, resolved colours, and the three ways a session's
// awaitingUser moves end to end — a worker callback re-invoking a waiting
// conductor, a text ask set and then cleared by a UI message, and a resume
// re-deriving the ask from the transcript.
//
// Each step waits for the API state first and reads the DOM second, so a FAIL
// says which half is broken.
//
//   node harness/playwright/check-sidebar-strip.mjs [--out DIR]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { bootOrch } from './boot-orch.mjs';
import { importCodePlaywright } from './paths.mjs';

const { withPage } = await importCodePlaywright();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Each fake process takes the first matching turn and consumes it: the wake
// stubs and the tagged long turns come before the plain catch-alls, none of
// which ends in an ask.
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-sidebar-strip.json');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : path.join(__dirname, 'screenshots');

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
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`); };

const orch = await bootOrch({ sandbox: true, scenario: SCENARIO });
const base = orch.url;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};
let rpcId = 1;
const callTool = async (name, args, caller) => {
  const url = base + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
};
const insts = async () => (await api('GET', '/api/instances')).body;
const inst = async (pred) => (await insts()).find(pred);
const statusIs = (id, status, opts) => waitFor(async () => (await inst(i => i.id === id))?.status === status, opts);

async function spawnWorker(caller, args) {
  const r = await callTool('spawn_instance', { mode: 'bypassPermissions', ...args }, caller);
  if (r.isError) throw new Error(`spawn_instance refused: ${r.content?.[0]?.text}`);
  const { sessionId } = JSON.parse(r.content[0].text);
  await waitFor(async () => (await inst(i => i.sessionId === sessionId))?.status === 'idle');
  return inst(i => i.sessionId === sessionId);
}

// A prompt the way the browser sends one: a real user message over /ws.
async function wsPrompt(instanceId, text) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  const messages = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const reqId = `r${rpcId++}`;
    ws.send(JSON.stringify({ t: 'prompt', id: instanceId, text, reqId }));
    await waitFor(() => messages.find(m => m.t === 'ack' || m.reqId === reqId));
  } finally {
    await new Promise(r => { ws.once('close', r); ws.close(); });
  }
}

// Append one record to an instance's session jsonl (fake-claude writes none).
// The file is named by the BACKING session id, which the API withholds; the
// sandbox store's session-lineage.json maps the public id to it.
async function appendTranscript(instanceId, record) {
  const i = await inst(x => x.id === instanceId);
  const lineage = JSON.parse(await fs.readFile(
    path.join(orch.sandbox.dirs.PROJECTS_ROOT, '.code-conductor', 'session-lineage.json'), 'utf8'));
  const backing = lineage.sessions?.[i.sessionId]?.current;
  if (!backing) throw new Error(`no backing id recorded for session ${i.sessionId}`);
  const dir = path.join(orch.sandbox.dirs.CLAUDE_PROJECTS_ROOT, i.cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${backing}.jsonl`),
    JSON.stringify({ sessionId: backing, timestamp: new Date().toISOString(), ...record }) + '\n');
}
const userLine = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolAskLine = (name, input) => ({
  type: 'assistant',
  message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'ta', name, input }], stop_reason: 'tool_use' },
});

const spawnConductor = async () => {
  const r = (await api('POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: false, playbookEnforcement: 'warn' })).body;
  await statusIs(r.id, 'idle');
  return inst(i => i.id === r.id);
};

const STATE_WORDS = /question|plan approval|asked in text|idle|running|on a worker|working|turn ended/;

let B; // the plan-ask conductor, opened again in the phone pass
try {
  await api('POST', '/api/projects', { name: 'uipass' });
  await api('POST', '/api/projects/.conduct/ensure');

  await withPage(async (page) => {
    await page.goto(base, { waitUntil: 'networkidle' });

    // The strip as the page renders it.
    const strip = () => page.evaluate(() => {
      const toRgb = (v) => { const i = document.createElement('i'); i.style.color = v; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; };
      const root = getComputedStyle(document.documentElement);
      const slot = document.getElementById('sidebar-strip-slot');
      const groups = {};
      for (const g of slot.querySelectorAll('.strip-group')) {
        const name = [...g.classList].find(c => c !== 'strip-group');
        groups[name] = {
          head: g.querySelector('.strip-head').textContent,
          entries: [...g.querySelectorAll('.strip-list > li')].map(li => {
            const b = li.querySelector('.strip-entry');
            const d = b.querySelector('.dot');
            const ds = getComputedStyle(d);
            return {
              sid: li.dataset.key.slice(6), text: b.textContent, aria: b.getAttribute('aria-label'),
              owned: b.classList.contains('owned'), active: b.classList.contains('active'),
              bar: getComputedStyle(b).boxShadow,
              dot: d.className, dotTitle: d.title, bg: ds.backgroundColor, shadow: ds.boxShadow, anim: ds.animationName,
            };
          }),
        };
      }
      return {
        children: slot.children.length, height: slot.getBoundingClientRect().height, groups,
        amber: toRgb(root.getPropertyValue('--amber').trim()),
        accent: toRgb(root.getPropertyValue('--accent').trim()),
        green: toRgb(root.getPropertyValue('--green').trim()),
      };
    });
    const entryIn = (s, group, sid) => s.groups[group]?.entries.find(e => e.sid === sid) ?? null;
    const groupsOf = (s, sid) => Object.keys(s.groups).filter(g => entryIn(s, g, sid));
    const allSids = (s) => Object.values(s.groups).flatMap(g => g.entries.map(e => e.sid));
    const colourOf = (sid) => page.evaluate(async (s) => {
      const { conductorColor } = await import('/conductorColor.js');
      const probe = document.createElement('i');
      probe.style.color = conductorColor(s);
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, sid);
    const waitStrip = (pred, timeout = 15000) => waitFor(async () => { const s = await strip(); return pred(s) ? s : false; }, { timeout })
      .catch(() => strip());
    const workerSids = [];
    const noWorkers = (s) => !allSids(s).some(sid => workerSids.includes(sid));
    let workersEverListed = false;
    const sample = async (pred, timeout) => {
      const s = await waitStrip(pred, timeout);
      if (!noWorkers(s)) workersEverListed = true;
      return s;
    };

    // 0 — nothing spawned: no strip.
    {
      const s = await strip();
      check('0 nothing live: the slot has no child and no height', s.children === 0 && s.height === 0, JSON.stringify({ children: s.children, height: s.height }));
    }

    // 1 — an idle conductor D and an idle hand-spawned H are Finished.
    const D = await spawnConductor();
    const hRes = (await api('POST', '/api/instances', { project: 'uipass', mode: 'bypassPermissions' })).body;
    await statusIs(hRes.id, 'idle');
    const H = await inst(i => i.id === hRes.id);
    const colD = await colourOf(D.sessionId);
    {
      const s = await sample(x => entryIn(x, 'finished', D.sessionId) && entryIn(x, 'finished', H.sessionId));
      const d = entryIn(s, 'finished', D.sessionId), h = entryIn(s, 'finished', H.sessionId);
      check('1 idle conductor and hand-spawned session are Finished; the conductor carries its colour bar',
        !!d && !!h && d.dot === 'dot idle' && h.dot === 'dot idle' && d.owned && d.bar.includes(colD) && !h.owned
          && d.aria.endsWith(' — turn ended') && h.aria.endsWith(' — turn ended'),
        JSON.stringify({ d, h, colD }));
      await page.screenshot({ path: path.join(OUT, 'strip-missions.png') });
    }

    // 2 — D in a turn is Running (pulsing); H in a turn is not listed.
    {
      await wsPrompt(D.id, 'SLOW');
      await wsPrompt(H.id, 'SLOW');
      await statusIs(D.id, 'turn');
      await statusIs(H.id, 'turn');
      const s = await sample(x => entryIn(x, 'running', D.sessionId) && !groupsOf(x, H.sessionId).length);
      const d = entryIn(s, 'running', D.sessionId);
      check('2 a conductor in a turn is Running with a pulsing dot; a hand-spawned session in a turn is absent',
        !!d && d.dot === 'dot turn' && d.anim !== 'none' && d.aria.endsWith(' — working') && groupsOf(s, H.sessionId).length === 0,
        JSON.stringify({ d, h: groupsOf(s, H.sessionId) }));
      await statusIs(D.id, 'idle');
      await statusIs(H.id, 'idle');
    }

    // 3 — D idle on a worker is Running, accent dot; the worker is never listed.
    let Wd;
    {
      Wd = await spawnWorker(D.id, { project: 'uipass' });
      workerSids.push(Wd.sessionId);
      await callTool('send_prompt', { sessionId: Wd.sessionId, text: 'WORKER-GO' }, D.id);
      await statusIs(Wd.id, 'turn');
      await waitFor(async () => { const x = await inst(i => i.id === D.id); return x.status === 'idle' && x.awaitingWake; });
      const s = await sample(x => entryIn(x, 'running', D.sessionId)?.dot === 'dot idle awaiting');
      const d = entryIn(s, 'running', D.sessionId);
      check('3 a conductor idle on a worker is Running with the accent dot',
        !!d && d.dot === 'dot idle awaiting' && d.bg === s.accent && d.aria.endsWith(' — on a worker') && noWorkers(s),
        JSON.stringify({ d, accent: s.accent }));
    }

    // 4 — a text ask: conductor A (titled) and H are Waiting on you.
    const A = await spawnConductor();
    await api('PUT', `/api/sessions/${A.sessionId}/title`, { title: 'Alpha mission' });
    let asks = {};
    {
      await wsPrompt(A.id, 'ASK-TEXT');
      const apiA = await waitFor(async () => { const x = await inst(i => i.id === A.id); return x.status === 'idle' && x.awaitingUser ? x : false; })
        .catch(() => inst(i => i.id === A.id));
      const s = await sample(x => entryIn(x, 'waiting', A.sessionId));
      const a = entryIn(s, 'waiting', A.sessionId);
      const row = await page.evaluate((sid) => {
        const d = document.querySelector(`#mission-list [data-key="mission:${sid}"] .mission-row > .dot`);
        return d ? { cls: d.className, title: d.title } : null;
      }, A.sessionId);
      check('4a a text ask sets awaitingUser question/text on the API',
        apiA.awaitingUser === 'question' && apiA.awaitingUserSource === 'text', JSON.stringify({ awaitingUser: apiA.awaitingUser, src: apiA.awaitingUserSource }));
      check('4b the asking conductor is in Waiting on you with the amber-ringed dot; its mission row is ringed too',
        !!a && a.dot === 'dot idle needs-you' && a.bg === s.amber && a.shadow.includes(s.amber)
          && a.aria === 'Alpha mission — asked in text · idle' && a.text === 'Alpha mission'
          && row?.cls === 'dot idle needs-you' && row.title === 'waiting on you (asked in text) · idle'
          && s.groups.waiting.head === 'Waiting on you (1)',
        JSON.stringify({ a, row, amber: s.amber }));
      asks.text = a?.aria;
      await wsPrompt(H.id, 'ASK-TEXT');
      await waitFor(async () => (await inst(i => i.id === H.id)).awaitingUser === 'question');
      const s2 = await sample(x => entryIn(x, 'waiting', H.sessionId));
      const h = entryIn(s2, 'waiting', H.sessionId);
      check('4c a hand-spawned text ask is Waiting on you too, without a bar',
        !!h && h.dot === 'dot idle needs-you' && !h.owned, JSON.stringify(h));
    }

    // 5 — A on a worker stays Waiting, ring over the accent fill.
    let Wa;
    {
      Wa = await spawnWorker(A.id, { project: 'uipass' });
      workerSids.push(Wa.sessionId);
      await callTool('send_prompt', { sessionId: Wa.sessionId, text: 'WORKER-GO' }, A.id);
      await statusIs(Wa.id, 'turn');
      await waitFor(async () => (await inst(i => i.id === A.id)).awaitingWake);
      const s = await sample(x => entryIn(x, 'waiting', A.sessionId)?.dot === 'dot idle awaiting needs-you');
      const a = entryIn(s, 'waiting', A.sessionId);
      check('5 a waiting conductor on a worker stays in Waiting (not Running), ring over the accent fill',
        !!a && a.dot === 'dot idle awaiting needs-you' && a.bg === s.accent && groupsOf(s, A.sessionId).length === 1,
        JSON.stringify({ a, groups: groupsOf(s, A.sessionId) }));
    }

    // 6 — the worker callback re-invokes A: still Waiting, green ring, no pulse.
    {
      await statusIs(Wa.id, 'idle', { timeout: 30000 });
      const during = await waitFor(async () => { const x = await inst(i => i.id === A.id); return x.status === 'turn' ? x : false; }, { timeout: 15000 })
        .catch(() => inst(i => i.id === A.id));
      const s = await sample(x => entryIn(x, 'waiting', A.sessionId)?.dot === 'dot turn needs-you', 5000);
      const a = entryIn(s, 'waiting', A.sessionId);
      check('6a a worker callback re-invokes the waiting conductor: the API keeps awaitingUser through the wake turn',
        during.status === 'turn' && during.awaitingUser === 'question', JSON.stringify({ status: during.status, awaitingUser: during.awaitingUser }));
      check('6b during the wake turn it stays in Waiting, not Running: green fill in the ring, no pulse',
        !!a && a.dot === 'dot turn needs-you' && a.bg === s.green && a.anim === 'none' && groupsOf(s, A.sessionId).length === 1
          && a.aria === 'Alpha mission — asked in text · running',
        JSON.stringify({ a, groups: groupsOf(s, A.sessionId), green: s.green }));
      await statusIs(A.id, 'idle', { timeout: 20000 });
      const after = await sample(x => entryIn(x, 'waiting', A.sessionId)?.dot === 'dot idle needs-you');
      const apiA = await inst(i => i.id === A.id);
      check('6c after the wake turn ends it is still Waiting (sticky)',
        apiA.awaitingUser === 'question' && entryIn(after, 'waiting', A.sessionId)?.dot === 'dot idle needs-you',
        JSON.stringify({ awaitingUser: apiA.awaitingUser, entry: entryIn(after, 'waiting', A.sessionId) }));
    }

    // 7 — opening A from the strip, then a UI message clears the ask.
    {
      await page.click(`#sidebar-strip-slot [data-key="entry:${A.sessionId}"] .strip-entry`);
      const v = await waitFor(() => page.evaluate(() => {
        const t = document.getElementById('instance-title')?.textContent ?? '';
        const panel = document.getElementById('subagent-panel');
        const shown = panel && !panel.hidden && panel.getBoundingClientRect().height > 0;
        return t.includes('Alpha mission') && shown ? { t } : false;
      }), { timeout: 10000 }).catch(() => null);
      const s = await sample(x => entryIn(x, 'waiting', A.sessionId)?.active);
      check('7a clicking the strip entry opens the session (title + sub-agent panel) and marks the entry active',
        !!v && !!entryIn(s, 'waiting', A.sessionId)?.active, JSON.stringify({ v, entry: entryIn(s, 'waiting', A.sessionId) }));
      await page.waitForSelector('#composer-input:not([disabled])');
      await page.fill('#composer-input', 'go ahead');
      await page.click('#composer-send');
      const cleared = await waitFor(async () => { const x = await inst(i => i.id === A.id); return x.awaitingUser === null ? x : false; })
        .catch(() => inst(i => i.id === A.id));
      await statusIs(A.id, 'idle');
      const s2 = await sample(x => entryIn(x, 'finished', A.sessionId));
      const a = entryIn(s2, 'finished', A.sessionId);
      check('7b a UI message clears awaitingUser; A leaves Waiting and lands in Finished, unringed',
        cleared.awaitingUser === null && !!a && a.dot === 'dot idle' && groupsOf(s2, A.sessionId).length === 1,
        JSON.stringify({ awaitingUser: cleared.awaitingUser, a, groups: groupsOf(s2, A.sessionId) }));
    }

    // 8 — a resume re-derives the ask from the transcript.
    const resumeWithAsk = async (tool, input) => {
      const X = await spawnConductor();
      await appendTranscript(X.id, userLine('real prompt'));
      await appendTranscript(X.id, toolAskLine(tool, input));
      await api('DELETE', `/api/instances/${X.id}`);
      await waitFor(async () => { const x = await inst(i => i.id === X.id); return !x || x.status === 'exited'; });
      const dead = await sample(x => !groupsOf(x, X.sessionId).length);
      const r = (await api('POST', '/api/instances', { project: '.conduct', resume: X.sessionId, mode: 'bypassPermissions', playbookEnforcement: 'warn' })).body;
      await statusIs(r.id, 'idle');
      const back = await inst(i => i.id === r.id);
      const s = await sample(x => entryIn(x, 'waiting', X.sessionId));
      return { X: back, deadListed: groupsOf(dead, X.sessionId), entry: entryIn(s, 'waiting', X.sessionId) };
    };
    {
      const b = await resumeWithAsk('ExitPlanMode', { plan: 'p' });
      B = b.X;
      check('8a a killed conductor is absent from the strip; resumed onto an ExitPlanMode transcript it is Waiting with plan approval',
        b.deadListed.length === 0 && b.X.awaitingUser === 'plan' && b.X.awaitingUserSource === 'tool'
          && !!b.entry && b.entry.aria.endsWith(' — plan approval · idle') && b.entry.dot === 'dot idle needs-you',
        JSON.stringify({ dead: b.deadListed, awaitingUser: b.X.awaitingUser, src: b.X.awaitingUserSource, entry: b.entry }));
      asks.plan = b.entry?.aria;
      const c = await resumeWithAsk('AskUserQuestion', { questions: [{ question: 'q' }] });
      check('8b resumed onto an AskUserQuestion transcript it is Waiting with question',
        c.X.awaitingUser === 'question' && c.X.awaitingUserSource === 'tool' && !!c.entry && c.entry.aria.endsWith(' — question · idle'),
        JSON.stringify({ awaitingUser: c.X.awaitingUser, src: c.X.awaitingUserSource, entry: c.entry }));
      asks.question = c.entry?.aria;
    }

    // 9 — the three asks are distinct, and no entry renders a state word.
    {
      const s = await strip();
      const suffix = (a) => a?.split(' — ')[1];
      const texts = Object.values(s.groups).flatMap(g => g.entries.map(e => e.text));
      check('9 the three asks read distinctly; no entry renders state text',
        new Set([suffix(asks.text), suffix(asks.plan), suffix(asks.question)]).size === 3 && !texts.some(t => STATE_WORDS.test(t)),
        JSON.stringify({ asks, texts }));
    }

    // 10 — both lenses, one strip, above the toggle, nothing pinned.
    {
      const before = allSids(await strip());
      await page.click('.sidebar-lens button[data-lens="projects"]');
      await sleep(200);
      const s = await strip();
      const geo = await page.evaluate(() => {
        const top = (el) => el.getBoundingClientRect().top;
        const lens = document.querySelector('.sidebar-lens');
        return {
          heads: [...document.querySelectorAll('#sidebar-strip-slot .strip-head')].map(top),
          order: [top(document.getElementById('conduct-btn')), top(document.getElementById('sidebar-strip-slot')), top(lens)],
          lensTop: top(lens),
          pos: ['#sidebar-strip-slot', '.sidebar-strip', '.sidebar-lens'].map(sel => getComputedStyle(document.querySelector(sel)).position),
        };
      });
      const ordered = geo.order.every((v, i) => i === 0 || v > geo.order[i - 1]);
      check('10 the same strip in the Projects lens, above the toggle, nothing pinned',
        JSON.stringify(allSids(s)) === JSON.stringify(before) && geo.heads.length > 0 && geo.heads.every(t => t < geo.lensTop)
          && ordered && geo.pos.every(p => p === 'static'),
        JSON.stringify({ before, after: allSids(s), geo }));
      await page.screenshot({ path: path.join(OUT, 'strip-projects.png') });
      await page.click('.sidebar-lens button[data-lens="missions"]');
    }

    // 11 — workers were never listed.
    {
      const s = await strip();
      check('11 conducted workers never appear in the strip', !workersEverListed && noWorkers(s),
        JSON.stringify({ workers: workerSids, listed: allSids(s), everListed: workersEverListed }));
    }
  });

  // 12 — phone: a strip click closes the drawer and opens the session.
  await withPage(async (page) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('#sidebar-toggle');
    await page.waitForSelector(`#sidebar-strip-slot [data-key="entry:${B.sessionId}"] .strip-entry`);
    await sleep(400); // the drawer's slide-in transition
    const g = await page.evaluate(() => {
      const body = document.getElementById('sidebar-body');
      return { open: document.getElementById('sidebar').classList.contains('open'), sw: body.scrollWidth, cw: body.clientWidth };
    });
    await page.screenshot({ path: path.join(OUT, 'strip-phone.png') });
    await page.click(`#sidebar-strip-slot [data-key="entry:${B.sessionId}"] .strip-entry`);
    // B is untitled, so the header text alone is the same `.conduct` chip for
    // every conductor: its identity is the chip's `session <sid>` tooltip and
    // B's own entry being the active one.
    const after = await waitFor(() => page.evaluate((sid) => {
      const open = document.getElementById('sidebar').classList.contains('open');
      const chipTitle = document.querySelector('#instance-title .ih-project')?.title ?? '';
      const active = document.querySelector(`#sidebar-strip-slot [data-key="entry:${sid}"] .strip-entry`)?.classList.contains('active') ?? false;
      return !open && chipTitle === `session ${sid}` && active ? { open, chipTitle, active } : false;
    }, B.sessionId), { timeout: 10000 }).catch(() => page.evaluate((sid) => ({
      failed: true,
      open: document.getElementById('sidebar').classList.contains('open'),
      chipTitle: document.querySelector('#instance-title .ih-project')?.title ?? null,
      active: document.querySelector(`#sidebar-strip-slot [data-key="entry:${sid}"] .strip-entry`)?.classList.contains('active') ?? null,
    }), B.sessionId));
    check('12 phone: no sideways overflow; a strip click closes the drawer and opens that session (header names its sid, its entry is active)',
      g.open && g.sw <= g.cw && !after.failed, JSON.stringify({ g, after, sid: B.sessionId }));
  }, { viewport: { width: 390, height: 844 } });
} finally {
  await orch.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
