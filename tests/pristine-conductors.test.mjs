// Pristine conductors: a conductor started by New conductor is listed nowhere
// until its first prompt; the tab showing it declares its presence over the
// socket, and when the last viewer leaves (or closes, after the grace window)
// it is reaped with nothing left behind, or listed under its draft. Its first
// prompt makes it an ordinary conductor. The grace window is driven through the
// manager's `pristineTimers` seam, so no test sleeps it out.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { loadSessions, settleSessionWrites, isArchived } from '../src/sessionStore.ts';
import { drainToManifest } from '../src/resumeRestart.ts';

const SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-basic.json');

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); });
    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { if (ws.readyState === WebSocket.CLOSED) { r(); return; } ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) { return waitFor(() => messages.find(predicate), { timeout }); },
    }));
    ws.once('error', reject);
  });
}

let nextReq = 1;
/** Sends one frame and resolves with its ack. */
async function frame(c, obj) {
  const reqId = `r${nextReq++}`;
  c.send({ ...obj, reqId });
  return c.wait(m => m.t === 'ack' && m.reqId === reqId);
}

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result.content.map(c => c.text).join('\n');
}

/** Timers the manager arms through `pristineTimers`; `fire()` runs every one not cleared. */
function fakeTimers() {
  const armed = [];
  return {
    armed,
    live: () => armed.filter(h => !h.cleared && !h.fired),
    setTimeout(fn, ms) { const h = { fn, ms, cleared: false, fired: false }; armed.push(h); return h; },
    clearTimeout(h) { if (h) h.cleared = true; },
    fire() { for (const h of armed.filter(x => !x.cleared && !x.fired)) { h.fired = true; h.fn(); } },
  };
}

const hasRecord = async (sid) => (await loadSessions()).byPublic.has(sid);

describe('pristine conductors', () => {
  let ctx, baseUrl, instances, home, fake;
  const sockets = [];

  before(async () => {
    ctx = await bootServer({ scenarioPath: SCENARIO });
    ({ baseUrl, instances } = ctx);
  });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    fake = fakeTimers();
    instances.pristineTimers = fake;
  });
  afterEach(async () => {
    for (const c of sockets.splice(0)) await c.close();
    await instances.shutdown();
    // drainToManifest suspends wake delivery; the next test starts with it live.
    if (instances._idleHub) instances._idleHub._suspended = false;
    await settleSessionWrites();
    await rmrf(home);
  });

  async function socket() {
    const c = await wsClient(ctx.wsUrl);
    sockets.push(c);
    return c;
  }

  /** A conductor from New conductor's POST (`pristine: true`), idle, with its store record written. */
  async function conductor({ pristine = true } = {}) {
    const res = await api(baseUrl, 'POST', '/api/instances',
      { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions', ...(pristine ? { pristine: true } : {}) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    await waitFor(() => hasRecord(inst.sessionId));
    return { id: inst.id, sid: inst.sessionId, inst, backing: inst.backingSessionId };
  }

  /** Waits (bounded) for the server to see a socket close: it arms one grace timer. */
  const closeSeen = () => waitFor(() => fake.live().length === 1, { timeout: 3000 }).catch(() => {});

  const listed = async () => (await api(baseUrl, 'GET', '/api/instances')).body;
  const listedRow = async (id) => (await listed()).find(r => r.id === id) ?? null;

  /** Waits (bounded) for `id` to leave the manager and its store record to go; the assertions that follow judge it. */
  async function reaped(id, sid, timeout = 3000) {
    await waitFor(() => instances.get(id) === undefined, { timeout }).catch(() => {});
    await waitFor(async () => !(await hasRecord(sid)), { timeout }).catch(() => {});
  }

  async function assertGoneEverywhere(id, sid) {
    assert.equal(instances.get(id), undefined, 'the instance is removed');
    assert.equal(await hasRecord(sid), false, 'no store record is left');
    const archived = await api(baseUrl, 'GET', '/api/archived');
    assert.ok(!JSON.stringify(archived.body).includes(sid), 'absent from /api/archived');
    const locate = await api(baseUrl, 'GET', `/api/sessions/${sid}/locate`);
    assert.equal(locate.status, 404, 'locate finds nothing');
  }

  test('N1: a hidden pristine conductor is in no list payload (REST, list_sessions, describe_session)', async () => {
    const P = await conductor();
    const Q = await conductor({ pristine: false });
    const rows = await listed();
    const sessions = await callTool(baseUrl, 'list_sessions', {});
    // Positive control: the plain conductor is in both payloads.
    assert.ok(rows.some(r => r.id === Q.id), 'Q is in GET /api/instances');
    assert.ok(sessions.includes(Q.sid), 'Q is in list_sessions');
    assert.match(await callTool(baseUrl, 'describe_session', { sessionId: Q.sid }), /^SESSION \S+ {3}live$/m);
    assert.ok(!rows.some(r => r.id === P.id), 'P is not in GET /api/instances');
    assert.ok(!sessions.includes(P.sid), 'P is not in list_sessions');
    assert.doesNotMatch(await callTool(baseUrl, 'describe_session', { sessionId: P.sid }), /^SESSION \S+ {3}live$/m,
      'describe_session does not render P as live');
  });

  test('N2: the route refuses `pristine` off a fresh .conduct temp spawn', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const other = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', temp: true, pristine: true });
    assert.equal(other.status, 400, JSON.stringify(other.body));
    assert.equal(other.body.code, 'PRISTINE_NOT_FRESH_CONDUCTOR');
    const resumed = await api(baseUrl, 'POST', '/api/instances', { project: '.conduct', temp: true, resume: 'deadbeef', pristine: true });
    assert.equal(resumed.status, 400, JSON.stringify(resumed.body));
    assert.equal(resumed.body.code, 'PRISTINE_NOT_FRESH_CONDUCTOR');
  });

  test('N3: GET /api/sessions/:sid/pristine answers a live pristine conductor and 404s anything else', async () => {
    const P = await conductor();
    const Q = await conductor({ pristine: false });
    const q = await api(baseUrl, 'GET', `/api/sessions/${Q.sid}/pristine`);
    assert.equal(q.status, 404, 'a plain conductor is not pristine');
    const p = await api(baseUrl, 'GET', `/api/sessions/${P.sid}/pristine`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.id, P.id);
    assert.equal(p.body.pristine, true);
  });

  test('N4: a blank leave reaps the conductor fully', async () => {
    const P = await conductor();
    const A = await socket();
    assert.equal(await hasRecord(P.sid), true, 'control: the store record exists before the leave');
    await frame(A, { t: 'pristine_view', id: P.id });
    await frame(A, { t: 'pristine_leave', id: P.id, text: '  \n\t' });
    await reaped(P.id, P.sid);
    await assertGoneEverywhere(P.id, P.sid);
  });

  test('N5: a drafted leave lists it under its draft, one-lined and capped', async () => {
    const P = await conductor();
    const P2 = await conductor();
    const A = await socket();
    await frame(A, { t: 'pristine_view', id: P.id });
    await frame(A, { t: 'pristine_leave', id: P.id, text: '  Plan the\nrelease  ' });
    const row = await listedRow(P.id);
    assert.ok(row, 'P is listed');
    assert.equal(row.title, 'Plan the release');
    const long = `${'word '.repeat(20)}\n${'more '.repeat(20)}`;
    await frame(A, { t: 'pristine_view', id: P2.id });
    await frame(A, { t: 'pristine_leave', id: P2.id, text: long });
    const row2 = await listedRow(P2.id);
    assert.ok(row2, 'P2 is listed');
    assert.equal(row2.title.length, 100);
    assert.ok(!row2.title.includes('\n'), 'one line');
  });

  test('N6 (guard): a prompt before a blank leave on the same socket is never reaped', async () => {
    const P = await conductor();
    const A = await socket();
    await frame(A, { t: 'pristine_view', id: P.id });
    A.send({ t: 'prompt', id: P.id, text: 'go', reqId: 'p1' });
    A.send({ t: 'pristine_leave', id: P.id, text: '', reqId: 'l1' });
    await A.wait(m => m.t === 'ack' && m.reqId === 'l1');
    await waitFor(() => P.inst.firstPrompt === 'go');
    assert.ok(instances.get(P.id), 'P is alive');
    const row = await listedRow(P.id);
    assert.ok(row, 'P is listed');
    assert.equal(row.firstPrompt, 'go');
    assert.equal(await hasRecord(P.sid), true, 'the store record is kept');
  });

  test('N7: the first prompt replaces the draft title; a manual rename survives both', async () => {
    const P = await conductor();
    const A = await socket();
    await frame(A, { t: 'pristine_view', id: P.id });
    await frame(A, { t: 'pristine_leave', id: P.id, text: 'draft text' });
    assert.equal((await listedRow(P.id))?.title, 'draft text', 'listed under its draft');
    await frame(A, { t: 'pristine_view', id: P.id });
    await frame(A, { t: 'prompt', id: P.id, text: 'hello' });
    await waitFor(() => P.inst.firstPrompt === 'hello');
    const row = await listedRow(P.id);
    assert.equal(row.title, null, 'no title after the first prompt');
    assert.equal(row.firstPrompt, 'hello');

    const R = await conductor();
    const put = await api(baseUrl, 'PUT', `/api/sessions/${R.sid}/title`, { title: 'Mine' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await frame(A, { t: 'pristine_view', id: R.id });
    await frame(A, { t: 'pristine_leave', id: R.id, text: 'draft text' });
    assert.equal((await listedRow(R.id))?.title, 'Mine', 'the manual title wins over the draft');
    await frame(A, { t: 'pristine_view', id: R.id });
    await frame(A, { t: 'prompt', id: R.id, text: 'hello' });
    await waitFor(() => R.inst.firstPrompt === 'hello');
    assert.equal((await listedRow(R.id))?.title, 'Mine', 'and survives the first prompt');
  });

  describe('N15: only a pristine conductor\'s prompt ends pristine', () => {
    /** Prompts `x` over a socket and waits for that turn to end; returns the manager's list_changed and the instance's pristine_ended counts over it. */
    async function promptCounting(x) {
      const A = await socket();
      let listChanged = 0;
      let ended = 0;
      const onList = () => { listChanged++; };
      const onEnded = () => { ended++; };
      instances.on('list_changed', onList);
      x.inst.on('pristine_ended', onEnded);
      try {
        const turnEnds = () => x.inst.ringSnapshot().filter(e => e.kind === 'turn_end').length;
        const before = turnEnds();
        assert.equal((await frame(A, { t: 'prompt', id: x.id, text: 'go' })).ok, true);
        await waitFor(() => turnEnds() > before && x.inst.status === 'idle');
        await settleSessionWrites();
      } finally {
        instances.off('list_changed', onList);
        x.inst.off('pristine_ended', onEnded);
      }
      return { listChanged, ended };
    }

    test('a plain conductor\'s prompt emits no pristine_ended and no list_changed', async () => {
      const Q = await conductor({ pristine: false });
      assert.deepEqual(await promptCounting(Q), { listChanged: 0, ended: 0 });
    });

    test('twin: a pristine conductor\'s first prompt emits exactly one of each', async () => {
      const P = await conductor();
      assert.deepEqual(await promptCounting(P), { listChanged: 1, ended: 1 });
      assert.equal(P.inst.pristine, false);
    });
  });

  describe('N8: the grace window after a socket close', () => {
    test('outside it: a close with no return reaps the conductor', async () => {
      const P = await conductor();
      const A = await socket();
      await frame(A, { t: 'pristine_view', id: P.id });
      assert.equal(fake.live().length, 0, 'control: the view cancelled the creation timer');
      await A.close();
      await closeSeen();
      assert.ok(instances.get(P.id), 'alive until the window ends');
      fake.fire();
      await reaped(P.id, P.sid);
      await assertGoneEverywhere(P.id, P.sid);
      assert.equal(fake.armed.at(-1).ms, instances.pristineGraceMs, 'the close armed the grace window');
    });

    test('inside it: a new socket viewing before the window ends keeps the conductor', async () => {
      const P = await conductor();
      const A = await socket();
      await frame(A, { t: 'pristine_view', id: P.id });
      await A.close();
      await closeSeen();
      assert.equal(fake.live().length, 1, 'control: the close armed the grace window');
      const B = await socket();
      await frame(B, { t: 'pristine_view', id: P.id });
      assert.equal(fake.live().length, 0, 'the view cancelled the window');
      fake.fire();
      // A reap is remove() → kill(): bounded wait for any sign of one before judging that none came.
      await waitFor(() => instances.get(P.id) === undefined || P.inst.proc === null
        || ['exited', 'crashed'].includes(P.inst.status), { timeout: 1500 }).catch(() => {});
      await settleSessionWrites();
      assert.ok(instances.get(P.id), 'P is still registered');
      assert.ok(P.inst.proc, 'its CLI was not killed');
      assert.equal(P.inst.status, 'idle');
      assert.equal(await hasRecord(P.sid), true, 'its store record is kept');
    });

    test('never viewed: a conductor no tab ever shows is reaped when the window ends', async () => {
      const P = await conductor();
      fake.fire();
      await reaped(P.id, P.sid);
      await assertGoneEverywhere(P.id, P.sid);
    });

    test('a synced draft: the close lists it under that draft', async () => {
      const P = await conductor();
      const A = await socket();
      await frame(A, { t: 'pristine_view', id: P.id });
      await frame(A, { t: 'pristine_draft', id: P.id, text: 'x' });
      await A.close();
      await closeSeen();
      fake.fire();
      assert.equal((await listedRow(P.id))?.title, 'x');
    });

    test('after a prompt: the close leaves it alone', async () => {
      const P = await conductor();
      const A = await socket();
      await frame(A, { t: 'pristine_view', id: P.id });
      await frame(A, { t: 'prompt', id: P.id, text: 'go' });
      await A.close();
      fake.fire();
      await settleSessionWrites();
      assert.ok(instances.get(P.id), 'P is alive');
      assert.equal(await hasRecord(P.sid), true);
    });
  });

  test('N9: another viewer blocks the reap until it leaves too', async () => {
    const P = await conductor();
    const A = await socket();
    const B = await socket();
    await frame(A, { t: 'pristine_view', id: P.id });
    await frame(B, { t: 'pristine_view', id: P.id });
    await frame(A, { t: 'pristine_leave', id: P.id, text: '' });
    await settleSessionWrites();
    assert.ok(instances.get(P.id), 'P is alive while B views it');
    await frame(B, { t: 'pristine_leave', id: P.id, text: '' });
    await reaped(P.id, P.sid);
    await assertGoneEverywhere(P.id, P.sid);
  });

  test('N10: any pristine exit removes it rather than archiving it', async () => {
    const P = await conductor();
    const A = await socket();
    assert.equal(await hasRecord(P.sid), true, 'control: the store record exists');
    await frame(A, { t: 'kill', id: P.id });
    await waitFor(() => instances.get(P.id) === undefined);
    await waitFor(async () => !(await hasRecord(P.sid)), { timeout: 3000 }).catch(() => {});
    assert.equal(await hasRecord(P.sid), false, 'no store record, archived or otherwise');
    const archived = await api(baseUrl, 'GET', '/api/archived');
    assert.ok(!JSON.stringify(archived.body).includes(P.sid), 'absent from /api/archived');
  });

  test('N11 (guard): presence frames on a plain conductor are no-ops, and killing it still archives it', async () => {
    const Q = await conductor({ pristine: false });
    const A = await socket();
    assert.equal((await frame(A, { t: 'pristine_view', id: Q.id })).ok, true);
    assert.equal((await frame(A, { t: 'pristine_leave', id: Q.id, text: '' })).ok, true);
    await settleSessionWrites();
    assert.ok(instances.get(Q.id), 'Q is alive');
    await frame(A, { t: 'kill', id: Q.id });
    await waitFor(() => isArchived(Q.backing));
    assert.equal(await hasRecord(Q.sid), true, 'the archived record is kept');
  });

  test('N12: a restart drain never carries a pristine conductor, hidden or drafted', async () => {
    const P = await conductor();
    const P2 = await conductor();
    const Q = await conductor({ pristine: false });
    const A = await socket();
    await frame(A, { t: 'pristine_view', id: P2.id });
    await frame(A, { t: 'pristine_leave', id: P2.id, text: 'draft' });
    const live = [...instances.byId.values()];
    for (const x of [P, P2, Q]) {
      const i = live.find(y => y.id === x.id);
      assert.ok(i && i.proc && i.sessionId, `control: ${x.sid} is live in byId, past finishDrain's live check`);
    }
    const entries = await drainToManifest({ instances, log: { warn() {}, info() {}, log() {} } });
    const sids = entries.map(e => e.sessionId);
    assert.ok(sids.includes(Q.sid), 'the plain conductor is carried');
    assert.ok(!sids.includes(P.sid), 'the hidden pristine conductor is not');
    assert.ok(!sids.includes(P2.sid), 'the drafted pristine conductor is not');
  });

  describe('N13: a second visit to a drafted, listed conductor', () => {
    async function drafted() {
      const P = await conductor();
      const A = await socket();
      await frame(A, { t: 'pristine_view', id: P.id });
      await frame(A, { t: 'pristine_leave', id: P.id, text: 'first draft' });
      await A.close();
      const row = await listedRow(P.id);
      assert.equal(row?.title, 'first draft', 'control: listed under its first draft');
      return P;
    }

    test('(a) cleared and left: reaped completely though it was listed', async () => {
      const P = await drafted();
      const B = await socket();
      await frame(B, { t: 'pristine_view', id: P.id });
      await frame(B, { t: 'pristine_draft', id: P.id, text: '' });
      await frame(B, { t: 'pristine_leave', id: P.id, text: '' });
      await reaped(P.id, P.sid);
      await assertGoneEverywhere(P.id, P.sid);
    });

    test('(b) edited and left: the title follows the new draft', async () => {
      const P = await drafted();
      const B = await socket();
      await frame(B, { t: 'pristine_view', id: P.id });
      await frame(B, { t: 'pristine_leave', id: P.id, text: 'second draft' });
      assert.ok(instances.get(P.id), 'alive');
      assert.equal((await listedRow(P.id))?.title, 'second draft');
    });

    test('(c) edited, then the tab closes: the window lists the synced draft', async () => {
      const P = await drafted();
      const B = await socket();
      await frame(B, { t: 'pristine_view', id: P.id });
      await frame(B, { t: 'pristine_draft', id: P.id, text: 'third draft' });
      await B.close();
      await closeSeen();
      fake.fire();
      assert.equal((await listedRow(P.id))?.title, 'third draft');
    });

    test('(d) cleared, then the tab closes: the window reaps it', async () => {
      const P = await drafted();
      const B = await socket();
      await frame(B, { t: 'pristine_view', id: P.id });
      await frame(B, { t: 'pristine_draft', id: P.id, text: '' });
      await B.close();
      await closeSeen();
      fake.fire();
      await reaped(P.id, P.sid);
      await assertGoneEverywhere(P.id, P.sid);
    });

    test('(e) left unchanged: the title stays', async () => {
      const P = await drafted();
      const B = await socket();
      await frame(B, { t: 'pristine_view', id: P.id });
      await frame(B, { t: 'pristine_leave', id: P.id, text: 'first draft' });
      assert.ok(instances.get(P.id), 'alive');
      assert.equal((await listedRow(P.id))?.title, 'first draft');
    });
  });
});

describe('N14: orchestrator teardown of a hidden pristine conductor', () => {
  test('shutdown kills its CLI (guard) and removes its store record', async () => {
    const ctx = await bootServer({ scenarioPath: SCENARIO, realProcess: true });
    try {
      const res = await api(ctx.baseUrl, 'POST', '/api/instances',
        { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions', pristine: true });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const inst = ctx.instances.get(res.body.id);
      await waitFor(() => inst.status === 'idle' && inst.sessionId && inst.pid);
      const { pid, sessionId: sid } = inst;
      await waitFor(() => hasRecord(sid));
      assert.doesNotThrow(() => process.kill(pid, 0), 'control: the CLI is running');
      // What bootServer's close() runs first; the store is read before close() retargets it.
      await ctx.instances.shutdown();
      await settleSessionWrites();
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the CLI is gone');
      assert.equal(await hasRecord(sid), false, 'no store record is left');
    } finally { await ctx.close(); }
  });
});
