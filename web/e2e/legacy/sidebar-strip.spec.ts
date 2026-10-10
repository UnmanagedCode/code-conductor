// The old UI's sidebar needs-you strip and the waiting-on-you ring, in a real
// browser: rendered boxes, resolved colours, and the three ways a session's
// awaitingUser moves end to end — a worker callback re-invoking a waiting
// conductor, a text ask set and then cleared by a UI message, and a resume
// re-deriving the ask from the transcript.
//
// Each step waits for the API state first and reads the DOM second, so a red
// step says which half is broken.
//
// The scenario (fixtures/scenario-sidebar-strip.json): each fake process takes
// the first matching turn and consumes it — the wake stubs and the tagged long
// turns come before the plain catch-alls, none of which ends in an ask.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import WebSocket from 'ws';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api, createProject, mcpCall } from '../harness/api.ts';
import { FIXTURES } from '../harness/boot.ts';

test.use({
  ccOptions: { server: 'sidebar-strip', scenario: path.join(FIXTURES, 'scenario-sidebar-strip.json') },
  viewport: { width: 1280, height: 800 },
});
test.describe.configure({ mode: 'serial' });

type Inst = {
  id: string; sessionId: string; status: string; cwd: string;
  awaitingUser?: string | null; awaitingUserSource?: string | null; awaitingWake?: boolean;
};
type Entry = {
  sid: string; text: string; aria: string; owned: boolean; active: boolean; bar: string;
  dot: string; dotTitle: string; bg: string; shadow: string; anim: string;
};
type Strip = {
  children: number; height: number; groups: Record<string, { head: string; entries: Entry[] }>;
  amber: string; accent: string; green: string;
};
type Geo = { sid: string; active: boolean; fullRow: boolean; inside: boolean; clearOfTitle: boolean; onTop: boolean };

const STATE_WORDS = /question|plan approval|asked in text|idle|running|on a worker|working|turn ended/;
const POLL = { intervals: [100] };

/**
 * Waits up to `timeout` for `ok`, then returns the last value whether or not it
 * got there: the assertion that follows is the gate, and carries the detail.
 */
async function settle<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v: T | undefined;
    try { v = await fn(); if (ok(v)) return v; } catch { /* not readable yet */ }
    if (Date.now() > deadline) return fn();
    await new Promise((r) => setTimeout(r, 100));
  }
}

const insts = async (cc: Cc): Promise<Inst[]> => (await api<Inst[]>(cc, 'GET', '/api/instances')).body;
const inst = async (cc: Cc, pred: (i: Inst) => boolean): Promise<Inst | undefined> => (await insts(cc)).find(pred);
const byId = (cc: Cc, id: string) => inst(cc, (i) => i.id === id);

/** Polls an instance until `pred` holds (a red if it never does). */
async function instUntil(cc: Cc, id: string, pred: (i: Inst) => boolean, timeout = 20_000): Promise<void> {
  await expect.poll(async () => {
    try { const x = await byId(cc, id); return !!x && pred(x); } catch { return false; }
  }, { ...POLL, timeout, message: `instance ${id} never reached the awaited state` }).toBe(true);
}
const statusIs = (cc: Cc, id: string, status: string, timeout?: number) =>
  instUntil(cc, id, (i) => i.status === status, timeout);

async function spawnConductor(cc: Cc): Promise<Inst> {
  const r = (await api(cc, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: false, playbookEnforcement: 'warn' })).body;
  await statusIs(cc, r.id, 'idle');
  return (await byId(cc, r.id))!;
}

async function spawnWorker(cc: Cc, caller: string, args: Record<string, unknown>): Promise<Inst> {
  const r = await mcpCall(cc, 'spawn_instance', { mode: 'bypassPermissions', ...args }, caller);
  expect(r.isError, `spawn_instance refused: ${r.content?.[0]?.text}`).toBeFalsy();
  const { sessionId } = JSON.parse(r.content[0].text);
  await expect.poll(async () => (await inst(cc, (i) => i.sessionId === sessionId))?.status, { ...POLL, timeout: 20_000 }).toBe('idle');
  return (await inst(cc, (i) => i.sessionId === sessionId))!;
}

let wsSeq = 1;
/** A prompt the way the browser sends one: a real user message over /ws. */
async function wsPrompt(cc: Cc, instanceId: string, text: string): Promise<void> {
  const ws = new WebSocket(cc.url.replace(/^http/, 'ws') + '/ws');
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const reqId = `r${wsSeq++}`;
    ws.send(JSON.stringify({ t: 'prompt', id: instanceId, text, reqId }));
    await expect.poll(() => messages.some((m) => m.t === 'ack' || m.reqId === reqId), { ...POLL, timeout: 20_000 }).toBe(true);
  } finally {
    await new Promise((r) => { ws.once('close', r); ws.close(); });
  }
}

/**
 * Appends one record to an instance's session jsonl (fake-claude writes none).
 * The file is named by the BACKING session id, which the API withholds; the
 * store's sessions.json maps the public id to it (`.sessions[publicId].current`).
 */
async function appendTranscript(cc: Cc, instanceId: string, record: Record<string, unknown>): Promise<void> {
  const i = (await byId(cc, instanceId))!;
  const store = JSON.parse(await fs.readFile(path.join(cc.dirs.projects, '.code-conductor', 'sessions.json'), 'utf8'));
  const backing = store.sessions?.[i.sessionId]?.current;
  expect(backing, `no backing id recorded for session ${i.sessionId}`).toBeTruthy();
  const dir = path.join(cc.dirs.claudeProjects, i.cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${backing}.jsonl`),
    JSON.stringify({ sessionId: backing, timestamp: new Date().toISOString(), ...record }) + '\n');
}
const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const toolAskLine = (name: string, input: unknown) => ({
  type: 'assistant',
  message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'ta', name, input }], stop_reason: 'tool_use' },
});

/** The strip as the page renders it. */
const strip = (page: Page): Promise<Strip> => page.evaluate(() => {
  const toRgb = (v: string) => {
    const i = document.createElement('i'); i.style.color = v; document.body.appendChild(i);
    const c = getComputedStyle(i).color; i.remove(); return c;
  };
  const root = getComputedStyle(document.documentElement);
  const slot = document.getElementById('sidebar-strip-slot')!;
  const groups: Record<string, { head: string; entries: Entry[] }> = {};
  for (const g of slot.querySelectorAll('.strip-group')) {
    const name = [...g.classList].find((c) => c !== 'strip-group')!;
    groups[name] = {
      head: g.querySelector('.strip-head')!.textContent ?? '',
      entries: [...g.querySelectorAll<HTMLElement>('.strip-list > li')].map((li) => {
        const b = li.querySelector<HTMLElement>('.strip-entry')!;
        const d = b.querySelector<HTMLElement>('.dot')!;
        const ds = getComputedStyle(d);
        return {
          sid: li.dataset.key!.slice(6), text: b.textContent ?? '', aria: b.getAttribute('aria-label') ?? '',
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
const entryIn = (s: Strip, group: string, sid: string): Entry | null => s.groups[group]?.entries.find((e) => e.sid === sid) ?? null;
const groupsOf = (s: Strip, sid: string) => Object.keys(s.groups).filter((g) => entryIn(s, g, sid));
const allSids = (s: Strip) => Object.values(s.groups).flatMap((g) => g.entries.map((e) => e.sid));

/** The resolved colour `conductorColor(sid)` paints, computed in the page from /conductorColor.js. */
const colourOf = (page: Page, sid: string): Promise<string> => page.evaluate(async ({ s, url }) => {
  const { conductorColor } = await import(url);
  const probe = document.createElement('i');
  probe.style.color = conductorColor(s);
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, { s: sid, url: '/conductorColor.js' });

/**
 * Per strip entry, where its box, its × and its title really sit (layout is
 * unreadable under happy-dom).
 */
const closeGeometry = (page: Page): Promise<Geo[]> => page.evaluate(() => {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  return [...document.querySelectorAll<HTMLElement>('#sidebar-strip-slot .strip-list > li')].map((li) => {
    const entry = li.querySelector<HTMLElement>('.strip-entry')!;
    const close = li.querySelector<HTMLElement>('.session-delete')!;
    const b = entry.getBoundingClientRect(), x = close.getBoundingClientRect();
    const t = entry.querySelector('.strip-title')!.getBoundingClientRect(), r = li.getBoundingClientRect();
    return {
      sid: li.dataset.key!.slice(6), active: entry.classList.contains('active'),
      fullRow: near(b.left, r.left) && near(b.right, r.right),
      inside: x.left >= b.left && x.right <= b.right && x.top >= b.top && x.bottom <= b.bottom,
      clearOfTitle: t.right <= x.left,
      onTop: document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2) === close,
    };
  });
});
/** Every × sits inside its entry's full-row box, clear of the title and on top. */
function expectCloseInsideBox(geo: Geo[]): void {
  const detail = JSON.stringify(geo);
  expect(geo.length, detail).toBeGreaterThan(0);
  for (const e of geo) expect({ fullRow: e.fullRow, inside: e.inside, clearOfTitle: e.clearOfTitle, onTop: e.onTop }, detail)
    .toEqual({ fullRow: true, inside: true, clearOfTitle: true, onTop: true });
}

let B: Inst; // the plan-ask conductor, opened again in the phone pass

test('desktop: every strip group and the waiting-on-you ring, through each way awaitingUser moves', async ({ page, cc }) => {
  test.setTimeout(240_000);
  await createProject(cc, 'uipass');
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  await page.goto('/legacy/', { waitUntil: 'networkidle' });

  const waitStrip = (pred: (s: Strip) => boolean, timeout = 15_000) => settle(() => strip(page), pred, timeout);
  const workerSids: string[] = [];
  const noWorkers = (s: Strip) => !allSids(s).some((sid) => workerSids.includes(sid));
  let workersEverListed = false;
  const sample = async (pred: (s: Strip) => boolean, timeout?: number) => {
    const s = await waitStrip(pred, timeout);
    if (!noWorkers(s)) workersEverListed = true;
    return s;
  };
  const shot = async (name: string) =>
    test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });

  await test.step('0 nothing live: the slot has no child and no height', async () => {
    const s = await strip(page);
    expect({ children: s.children, height: s.height }).toEqual({ children: 0, height: 0 });
  });

  const D = await spawnConductor(cc);
  const hRes = (await api(cc, 'POST', '/api/instances', { project: 'uipass', mode: 'bypassPermissions' })).body;
  await statusIs(cc, hRes.id, 'idle');
  const H = (await byId(cc, hRes.id))!;

  await test.step('1 idle conductor and hand-spawned session are Finished; the conductor carries its colour bar', async () => {
    const colD = await colourOf(page, D.sessionId);
    const s = await sample((x) => !!entryIn(x, 'finished', D.sessionId) && !!entryIn(x, 'finished', H.sessionId));
    const d = entryIn(s, 'finished', D.sessionId), h = entryIn(s, 'finished', H.sessionId);
    const detail = JSON.stringify({ d, h, colD });
    expect(d, detail).not.toBeNull();
    expect(h, detail).not.toBeNull();
    expect(d!.dot, detail).toBe('dot idle');
    expect(h!.dot, detail).toBe('dot idle');
    expect(d!.owned, detail).toBe(true);
    expect(d!.bar, detail).toContain(colD);
    expect(h!.owned, detail).toBe(false);
    expect(d!.aria, detail).toMatch(/ — turn ended$/);
    expect(h!.aria, detail).toMatch(/ — turn ended$/);
    await shot('strip-conductors.png');
  });

  await test.step('2 a conductor in a turn is Running with a pulsing dot; a hand-spawned session in a turn is absent', async () => {
    await wsPrompt(cc, D.id, 'SLOW');
    await wsPrompt(cc, H.id, 'SLOW');
    await statusIs(cc, D.id, 'turn');
    await statusIs(cc, H.id, 'turn');
    const s = await sample((x) => !!entryIn(x, 'running', D.sessionId) && !groupsOf(x, H.sessionId).length);
    const d = entryIn(s, 'running', D.sessionId);
    const detail = JSON.stringify({ d, h: groupsOf(s, H.sessionId) });
    expect(d, detail).not.toBeNull();
    expect(d!.dot, detail).toBe('dot turn');
    expect(d!.anim, detail).not.toBe('none');
    expect(d!.aria, detail).toMatch(/ — working$/);
    expect(groupsOf(s, H.sessionId), detail).toEqual([]);
    await statusIs(cc, D.id, 'idle');
    await statusIs(cc, H.id, 'idle');
  });

  await test.step('3 a conductor idle on a worker is Running with the accent dot; the worker is never listed', async () => {
    const Wd = await spawnWorker(cc, D.id, { project: 'uipass' });
    workerSids.push(Wd.sessionId);
    await mcpCall(cc, 'send_prompt', { sessionId: Wd.sessionId, text: 'WORKER-GO' }, D.id);
    await statusIs(cc, Wd.id, 'turn');
    await instUntil(cc, D.id, (x) => x.status === 'idle' && !!x.awaitingWake);
    const s = await sample((x) => entryIn(x, 'running', D.sessionId)?.dot === 'dot idle awaiting');
    const d = entryIn(s, 'running', D.sessionId);
    const detail = JSON.stringify({ d, accent: s.accent });
    expect(d, detail).not.toBeNull();
    expect(d!.dot, detail).toBe('dot idle awaiting');
    expect(d!.bg, detail).toBe(s.accent);
    expect(d!.aria, detail).toMatch(/ — on a worker$/);
    expect(noWorkers(s), detail).toBe(true);
  });

  // A text ask: conductor A (titled) and H are Waiting on you.
  const A = await spawnConductor(cc);
  await api(cc, 'PUT', `/api/sessions/${A.sessionId}/title`, { title: 'Alpha conductor' });
  const asks: { text?: string; plan?: string; question?: string } = {};

  await test.step('4 a text ask puts a conductor and a hand-spawned session in Waiting on you', async () => {
    await wsPrompt(cc, A.id, 'ASK-TEXT');
    const apiA = (await settle(() => byId(cc, A.id), (x) => x?.status === 'idle' && !!x.awaitingUser, 20_000))!;
    const s = await sample((x) => !!entryIn(x, 'waiting', A.sessionId));
    const a = entryIn(s, 'waiting', A.sessionId);
    const row = await page.evaluate((sid) => {
      const d = document.querySelector<HTMLElement>(`#conductor-list [data-key="conductor:${sid}"] .conductor-row > .dot`);
      return d ? { cls: d.className, title: d.title } : null;
    }, A.sessionId);

    // 4a
    expect({ awaitingUser: apiA.awaitingUser, src: apiA.awaitingUserSource }, '4a a text ask sets awaitingUser question/text on the API')
      .toEqual({ awaitingUser: 'question', src: 'text' });

    // 4b
    const detail = '4b the asking conductor is in Waiting on you with the amber-ringed dot; its conductor row is ringed too: '
      + JSON.stringify({ a, row, amber: s.amber });
    expect(a, detail).not.toBeNull();
    expect(a!.dot, detail).toBe('dot idle needs-you');
    expect(a!.bg, detail).toBe(s.amber);
    expect(a!.shadow, detail).toContain(s.amber);
    expect(a!.aria, detail).toBe('Alpha conductor — asked in text · idle');
    expect(a!.text, detail).toBe('Alpha conductor');
    expect(row, detail).toEqual({ cls: 'dot idle needs-you', title: 'waiting on you (asked in text) · idle' });
    expect(s.groups.waiting?.head, detail).toBe('Waiting on you (1)');
    asks.text = a!.aria;

    // 4c
    await wsPrompt(cc, H.id, 'ASK-TEXT');
    await instUntil(cc, H.id, (x) => x.awaitingUser === 'question');
    const s2 = await sample((x) => !!entryIn(x, 'waiting', H.sessionId));
    const h = entryIn(s2, 'waiting', H.sessionId);
    const detailH = '4c a hand-spawned text ask is Waiting on you too, without a bar: ' + JSON.stringify(h);
    expect(h, detailH).not.toBeNull();
    expect(h!.dot, detailH).toBe('dot idle needs-you');
    expect(h!.owned, detailH).toBe(false);
  });

  let Wa: Inst;
  await test.step('5 a waiting conductor on a worker stays in Waiting (not Running), ring over the accent fill', async () => {
    Wa = await spawnWorker(cc, A.id, { project: 'uipass' });
    workerSids.push(Wa.sessionId);
    await mcpCall(cc, 'send_prompt', { sessionId: Wa.sessionId, text: 'WORKER-GO' }, A.id);
    await statusIs(cc, Wa.id, 'turn');
    await instUntil(cc, A.id, (x) => !!x.awaitingWake);
    const s = await sample((x) => entryIn(x, 'waiting', A.sessionId)?.dot === 'dot idle awaiting needs-you');
    const a = entryIn(s, 'waiting', A.sessionId);
    const detail = JSON.stringify({ a, groups: groupsOf(s, A.sessionId) });
    expect(a, detail).not.toBeNull();
    expect(a!.dot, detail).toBe('dot idle awaiting needs-you');
    expect(a!.bg, detail).toBe(s.accent);
    expect(groupsOf(s, A.sessionId).length, detail).toBe(1);
  });

  await test.step('6 the worker callback re-invokes the waiting conductor: still Waiting, green fill, no pulse, sticky after', async () => {
    await statusIs(cc, Wa.id, 'idle', 30_000);
    const during = (await settle(() => byId(cc, A.id), (x) => x?.status === 'turn', 15_000))!;
    const s = await sample((x) => entryIn(x, 'waiting', A.sessionId)?.dot === 'dot turn needs-you', 5000);
    const a = entryIn(s, 'waiting', A.sessionId);

    // 6a
    expect({ status: during.status, awaitingUser: during.awaitingUser },
      '6a a worker callback re-invokes the waiting conductor: the API keeps awaitingUser through the wake turn')
      .toEqual({ status: 'turn', awaitingUser: 'question' });

    // 6b
    const detail = '6b during the wake turn it stays in Waiting, not Running: green fill in the ring, no pulse: '
      + JSON.stringify({ a, groups: groupsOf(s, A.sessionId), green: s.green });
    expect(a, detail).not.toBeNull();
    expect(a!.dot, detail).toBe('dot turn needs-you');
    expect(a!.bg, detail).toBe(s.green);
    expect(a!.anim, detail).toBe('none');
    expect(groupsOf(s, A.sessionId).length, detail).toBe(1);
    expect(a!.aria, detail).toBe('Alpha conductor — asked in text · running');

    // 6c
    await statusIs(cc, A.id, 'idle', 20_000);
    const after = await sample((x) => entryIn(x, 'waiting', A.sessionId)?.dot === 'dot idle needs-you');
    const apiA = (await byId(cc, A.id))!;
    const entry = entryIn(after, 'waiting', A.sessionId);
    expect({ awaitingUser: apiA.awaitingUser, dot: entry?.dot }, '6c after the wake turn ends it is still Waiting (sticky): '
      + JSON.stringify({ entry })).toEqual({ awaitingUser: 'question', dot: 'dot idle needs-you' });
  });

  await test.step('7 opening the session from the strip, then a UI message clears the ask', async () => {
    await page.click(`#sidebar-strip-slot [data-key="entry:${A.sessionId}"] .strip-entry`);
    const v = await settle(() => page.evaluate(() => {
      const t = document.getElementById('instance-title')?.textContent ?? '';
      const panel = document.getElementById('subagent-panel');
      const shown = !!panel && !panel.hidden && panel.getBoundingClientRect().height > 0;
      return { t, shown };
    }), (x) => x.t.includes('Alpha conductor') && x.shown, 10_000);
    const s = await sample((x) => !!entryIn(x, 'waiting', A.sessionId)?.active);

    // 7a
    const detail7a = '7a clicking the strip entry opens the session (title + sub-agent panel) and marks the entry active: '
      + JSON.stringify({ v, entry: entryIn(s, 'waiting', A.sessionId) });
    expect(v.t, detail7a).toContain('Alpha conductor');
    expect(v.shown, detail7a).toBe(true);
    expect(entryIn(s, 'waiting', A.sessionId)?.active, detail7a).toBe(true);

    // 7c — every × sits inside its entry's full-row box, clear of the title and on top; the active entry is among them.
    const geo = await closeGeometry(page);
    expectCloseInsideBox(geo);
    expect(geo.some((e) => e.active), `7c the active entry is among the measured ones: ${JSON.stringify(geo)}`).toBe(true);

    // 7b
    await page.waitForSelector('#composer-input:not([disabled])');
    await page.fill('#composer-input', 'go ahead');
    await page.click('#composer-send');
    const cleared = (await settle(() => byId(cc, A.id), (x) => x?.awaitingUser === null, 20_000))!;
    await statusIs(cc, A.id, 'idle');
    const s2 = await sample((x) => !!entryIn(x, 'finished', A.sessionId));
    const a = entryIn(s2, 'finished', A.sessionId);
    const detail7b = '7b a UI message clears awaitingUser; A leaves Waiting and lands in Finished, unringed: '
      + JSON.stringify({ awaitingUser: cleared.awaitingUser, a, groups: groupsOf(s2, A.sessionId) });
    expect(cleared.awaitingUser, detail7b).toBeNull();
    expect(a, detail7b).not.toBeNull();
    expect(a!.dot, detail7b).toBe('dot idle');
    expect(groupsOf(s2, A.sessionId).length, detail7b).toBe(1);
  });

  // A resume re-derives the ask from the transcript.
  const resumeWithAsk = async (tool: string, input: unknown) => {
    const X = await spawnConductor(cc);
    await appendTranscript(cc, X.id, userLine('real prompt'));
    await appendTranscript(cc, X.id, toolAskLine(tool, input));
    await api(cc, 'DELETE', `/api/instances/${X.id}`);
    await expect.poll(async () => { const x = await byId(cc, X.id); return !x || x.status === 'exited'; }, { ...POLL, timeout: 20_000 }).toBe(true);
    const dead = await sample((x) => !groupsOf(x, X.sessionId).length);
    const r = (await api(cc, 'POST', '/api/instances', { project: '.conduct', resume: X.sessionId, mode: 'bypassPermissions', playbookEnforcement: 'warn' })).body;
    await statusIs(cc, r.id, 'idle');
    const back = (await byId(cc, r.id))!;
    const s = await sample((x) => !!entryIn(x, 'waiting', X.sessionId));
    return { X: back, deadListed: groupsOf(dead, X.sessionId), entry: entryIn(s, 'waiting', X.sessionId) };
  };

  await test.step('8a a killed conductor is absent from the strip; resumed onto an ExitPlanMode transcript it is Waiting with plan approval', async () => {
    const b = await resumeWithAsk('ExitPlanMode', { plan: 'p' });
    B = b.X;
    const detail = JSON.stringify({ dead: b.deadListed, awaitingUser: b.X.awaitingUser, src: b.X.awaitingUserSource, entry: b.entry });
    expect(b.deadListed, detail).toEqual([]);
    expect(b.X.awaitingUser, detail).toBe('plan');
    expect(b.X.awaitingUserSource, detail).toBe('tool');
    expect(b.entry, detail).not.toBeNull();
    expect(b.entry!.aria, detail).toMatch(/ — plan approval · idle$/);
    expect(b.entry!.dot, detail).toBe('dot idle needs-you');
    asks.plan = b.entry!.aria;
  });

  await test.step('8b resumed onto an AskUserQuestion transcript it is Waiting with question', async () => {
    const c = await resumeWithAsk('AskUserQuestion', { questions: [{ question: 'q' }] });
    const detail = JSON.stringify({ awaitingUser: c.X.awaitingUser, src: c.X.awaitingUserSource, entry: c.entry });
    expect(c.X.awaitingUser, detail).toBe('question');
    expect(c.X.awaitingUserSource, detail).toBe('tool');
    expect(c.entry, detail).not.toBeNull();
    expect(c.entry!.aria, detail).toMatch(/ — question · idle$/);
    asks.question = c.entry!.aria;
  });

  await test.step('9 the three asks read distinctly; no entry renders state text', async () => {
    const s = await strip(page);
    const suffix = (a?: string) => a?.split(' — ')[1];
    const texts = Object.values(s.groups).flatMap((g) => g.entries.map((e) => e.text));
    const detail = JSON.stringify({ asks, texts });
    expect(new Set([suffix(asks.text), suffix(asks.plan), suffix(asks.question)]).size, detail).toBe(3);
    expect(texts.filter((t) => STATE_WORDS.test(t)), detail).toEqual([]);
  });

  await test.step('10 the same strip in the Projects lens, above the toggle, nothing pinned', async () => {
    const before = allSids(await strip(page));
    await page.click('.sidebar-lens button[data-lens="projects"]');
    await page.waitForTimeout(200);
    const s = await strip(page);
    const geo = await page.evaluate(() => {
      const top = (el: Element) => el.getBoundingClientRect().top;
      const lens = document.querySelector('.sidebar-lens')!;
      return {
        heads: [...document.querySelectorAll('#sidebar-strip-slot .strip-head')].map(top),
        order: [top(document.getElementById('conduct-btn')!), top(document.getElementById('sidebar-strip-slot')!), top(lens)],
        lensTop: top(lens),
        pos: ['#sidebar-strip-slot', '.sidebar-strip', '.sidebar-lens'].map((sel) => getComputedStyle(document.querySelector(sel)!).position),
      };
    });
    const detail = JSON.stringify({ before, after: allSids(s), geo });
    expect(allSids(s), detail).toEqual(before);
    expect(geo.heads.length, detail).toBeGreaterThan(0);
    for (const t of geo.heads) expect(t, detail).toBeLessThan(geo.lensTop);
    for (let i = 1; i < geo.order.length; i++) expect(geo.order[i], detail).toBeGreaterThan(geo.order[i - 1]);
    expect(geo.pos, detail).toEqual(['static', 'static', 'static']);
    await shot('strip-projects.png');
    await page.click('.sidebar-lens button[data-lens="conductors"]');
  });

  await test.step('11 conducted workers never appear in the strip', async () => {
    const s = await strip(page);
    const detail = JSON.stringify({ workers: workerSids, listed: allSids(s), everListed: workersEverListed });
    expect(workersEverListed, detail).toBe(false);
    expect(noWorkers(s), detail).toBe(true);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('phone: no sideways overflow; a strip click closes the drawer and opens that session', async ({ page }) => {
    expect(B, 'the desktop pass resumed the plan-ask conductor').toBeTruthy();
    await page.goto('/legacy/', { waitUntil: 'networkidle' });
    await page.click('#sidebar-toggle');
    await page.waitForSelector(`#sidebar-strip-slot [data-key="entry:${B.sessionId}"] .strip-entry`);
    await page.waitForTimeout(400); // the drawer's slide-in transition
    const g = await page.evaluate(() => {
      const body = document.getElementById('sidebar-body')!;
      return { open: document.getElementById('sidebar')!.classList.contains('open'), sw: body.scrollWidth, cw: body.clientWidth };
    });

    await test.step('12b phone: every strip × sits inside its entry\'s full-row box, clear of the title, on top', async () => {
      // The × is opacity 0 here (this viewport is not touch, so `(hover: none)`
      // does not match); opacity changes neither getBoundingClientRect nor
      // elementFromPoint, so the geometry is measured whatever the ×'s opacity.
      expectCloseInsideBox(await closeGeometry(page));
      await test.info().attach('strip-phone.png', { body: await page.screenshot(), contentType: 'image/png' });
    });

    await test.step('12 phone: no sideways overflow; a strip click closes the drawer and opens that session (header names its sid, its entry is active)', async () => {
      const gDetail = JSON.stringify({ g, sid: B.sessionId });
      expect(g.open, gDetail).toBe(true);
      expect(g.sw, gDetail).toBeLessThanOrEqual(g.cw);
      await page.click(`#sidebar-strip-slot [data-key="entry:${B.sessionId}"] .strip-entry`);
      // B is untitled, so the header text alone is the same `.conduct` chip for
      // every conductor: its identity is the chip's `session <sid>` tooltip and
      // B's own entry being the active one.
      const after = await settle(() => page.evaluate((sid) => ({
        open: document.getElementById('sidebar')!.classList.contains('open'),
        chipTitle: document.querySelector<HTMLElement>('#instance-title .ih-project')?.title ?? null,
        active: document.querySelector(`#sidebar-strip-slot [data-key="entry:${sid}"] .strip-entry`)?.classList.contains('active') ?? null,
      }), B.sessionId), (x) => !x.open && x.chipTitle === `session ${B.sessionId}` && x.active === true, 10_000);
      expect(after, JSON.stringify({ g, after, sid: B.sessionId }))
        .toEqual({ open: false, chipTitle: `session ${B.sessionId}`, active: true });
    });
  });
});
