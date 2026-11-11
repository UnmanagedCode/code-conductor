// The manager's session lifecycle relays — `session_launched`, `session_exited`,
// `turn_started`, `turn_ended` — which the event-log recorder
// (src/mcp/sessionRecorder.ts) turns into `session` and `turn` rows. Driven
// through a real server and fake CLI, so each case pins the emission site in
// src/instances.ts, not a stub.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, settle } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

describe('session lifecycle relays', () => {
  let ctx, baseUrl, instances, prevScenario;
  const seen = [];
  const RESUME_SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-resume.json');
  const EVENTS = ['session_launched', 'session_exited', 'turn_started', 'turn_ended'];

  before(async () => {
    ctx = await bootServer({});
    ({ baseUrl, instances } = ctx);
    prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = RESUME_SCENARIO;
    for (const e of EVENTS) instances.on(e, arg => seen.push({ e, ...arg }));
  });
  after(async () => {
    await ctx.close();
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  });

  let n = 0;
  async function project() {
    const name = `launch-signal-${++n}`;
    await api(baseUrl, 'POST', '/api/projects', { name });
    return name;
  }

  async function seedResumable(name, lines) {
    const sid = `${(n + 0x100).toString(16).padStart(8, '0')}-2222-3333-4444-555555555555`;
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, name)));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), (lines ?? [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
    ]).map(l => JSON.stringify(l)).join('\n') + '\n');
    return sid;
  }

  const idle = id => waitFor(() => instances.get(id).status === 'idle');
  const of = (sessionId, from = 0) => seen.slice(from).filter(x => x.sessionId === sessionId);
  const dead = id => waitFor(() => ['exited', 'crashed'].includes(instances.get(id).status));

  test('a fresh POST create announces one session_launched {event:start}, no cause, actor human, under the public id', async () => {
    const name = await project();
    const from = seen.length;
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await idle(r.body.id);
    await settle();
    const sid = instances.get(r.body.id).sessionId;
    const launches = of(sid, from).filter(x => x.e === 'session_launched');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].event, 'start');
    assert.equal('cause' in launches[0], false);
    assert.deepEqual(launches[0].actor, { type: 'human' });
    assert.equal(launches[0].conducted, false);
    assert.equal(launches[0].project, name);
  });

  test('a POST create({resume}) announces one {event:resume} with no cause', async () => {
    const name = await project();
    const sid = await seedResumable(name);
    const from = seen.length;
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions', resume: sid });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await idle(r.body.id);
    await settle();
    const launches = of(instances.get(r.body.id).sessionId, from).filter(x => x.e === 'session_launched');
    assert.deepEqual(launches.map(l => [l.event, l.cause, l.actor.type]), [['resume', undefined, 'human']]);
  });

  test('a kill emits session_exited once with the kill\'s actor; a respawn then announces {resume, cause:respawn}', async () => {
    const name = await project();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    const id = r.body.id;
    await idle(id);
    const inst = instances.get(id);
    const sid = inst.sessionId;
    await inst.prompt('hello');
    await waitFor(() => inst.status === 'idle');
    const from = seen.length;
    await inst.kill({ graceMs: 50, actor: { type: 'conductor', sessionId: 'c-killer' } });
    await dead(id);
    // A second dead status is the same death, not a second edge.
    inst._setStatus(inst.status === 'exited' ? 'crashed' : 'exited');
    await settle();
    const exits = of(sid, from).filter(x => x.e === 'session_exited');
    assert.equal(exits.length, 1, JSON.stringify(exits));
    assert.ok(['exited', 'crashed'].includes(exits[0].status));
    assert.deepEqual(exits[0].actor, { type: 'conductor', sessionId: 'c-killer' });
    assert.equal(of(sid, from).filter(x => x.e === 'session_launched').length, 0, 'the kill alone launches nothing');

    await api(baseUrl, 'POST', `/api/instances/${id}/respawn`, {});
    await idle(id);
    await settle();
    const launches = of(sid, from).filter(x => x.e === 'session_launched');
    assert.deepEqual(launches.map(l => [l.event, l.cause, l.actor.type]), [['resume', 'respawn', 'human']]);
  });

  test('an exit with no commanded actor is attributed to system', async () => {
    const name = await project();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    const id = r.body.id;
    await idle(id);
    const inst = instances.get(id);
    await inst.prompt('hello');
    await waitFor(() => inst.status === 'idle');
    const from = seen.length;
    await inst.kill({ graceMs: 50 });
    await dead(id);
    await settle();
    const exits = of(inst.sessionId, from).filter(x => x.e === 'session_exited');
    assert.deepEqual(exits.map(x => x.actor), [{ type: 'system' }]);
  });

  test('dead -> alive -> dead emits TWO exits, and a relaunch clears a kill actor left on the dead instance', async () => {
    // INVARIANTS: (1) a session this process resumed and that dies again gets a
    // second exit — one per announced launch; (2) a kill actor set while there is
    // no process (no edge consumes it) does not survive the next launch.
    const name = await project();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    const id = r.body.id;
    await idle(id);
    const inst = instances.get(id);
    const sid = inst.sessionId;
    await inst.prompt('hello');
    await waitFor(() => inst.status === 'idle');
    const from = seen.length;
    await inst.kill({ graceMs: 50, actor: { type: 'conductor', sessionId: 'c-first' } });
    await dead(id);
    // A kill with no process: nothing exits, so nothing consumes this actor.
    await inst.kill({ graceMs: 50, actor: { type: 'conductor', sessionId: 'c-stale' } });
    await instances.respawn(id);
    await idle(id);
    await inst.kill({ graceMs: 50 });
    await dead(id);
    await settle();
    const mine = of(sid, from).filter(x => x.e === 'session_exited' || x.e === 'session_launched');
    assert.deepEqual(mine.map(x => [x.e, x.event, x.actor]), [
      ['session_exited', undefined, { type: 'conductor', sessionId: 'c-first' }],
      ['session_launched', 'resume', { type: 'system' }],
      ['session_exited', undefined, { type: 'system' }],
    ]);
  });

  test('a project deletion emits the exit of its running sessions with actor human', async () => {
    const name = await project();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    await idle(r.body.id);
    const sid = instances.get(r.body.id).sessionId;
    const from = seen.length;
    const del = await api(baseUrl, 'DELETE', `/api/projects/${name}`, {});
    assert.equal(del.status, 200, JSON.stringify(del.body));
    await settle();
    assert.deepEqual(of(sid, from).filter(x => x.e === 'session_exited').map(x => x.actor), [{ type: 'human' }]);
  });

  test('a DELETE emits the exit with actor human', async () => {
    const name = await project();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    const id = r.body.id;
    await idle(id);
    const sid = instances.get(id).sessionId;
    const from = seen.length;
    const del = await api(baseUrl, 'DELETE', `/api/instances/${id}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    await settle();
    assert.deepEqual(of(sid, from).filter(x => x.e === 'session_exited').map(x => x.actor), [{ type: 'human' }]);
  });

  test('a conducted session\'s relays carry conducted:true, an ordinary one\'s conducted:false', async () => {
    const plainName = await project();
    const plain = await api(baseUrl, 'POST', '/api/instances', { project: plainName, mode: 'bypassPermissions' });
    await idle(plain.body.id);
    const name = await project();
    const from = seen.length;
    const conducted = await instances.create({ project: name, mode: 'bypassPermissions', conducted: true });
    await idle(conducted.id);
    await settle();
    const ev = of(conducted.sessionId, from).find(x => x.e === 'session_launched');
    assert.equal(ev?.conducted, true);
    assert.equal(ev?.actor.type, 'system', 'create() without an actor is system');
    const plainEv = seen.find(x => x.e === 'session_launched' && x.sessionId === instances.get(plain.body.id).sessionId);
    assert.equal(plainEv?.conducted, false);
  });

  test('a turn is relayed start then end, the start\'s actor following the prompt\'s author — an internal prompt is the system\'s', async () => {
    const name = await project();
    const owner = await instances.create({ project: name, mode: 'bypassPermissions' });
    await idle(owner.id);
    const actors = [];
    // One worker per author: the scenario answers one prompt per process.
    for (const opts of [{ author: 'human' }, { author: 'conductor' }, {}, { internal: true, author: 'human' }]) {
      const worker = await instances.create({ project: name, mode: 'bypassPermissions', conducted: true, callerInstanceId: owner.id });
      await idle(worker.id);
      assert.equal(worker.rootSessionId, owner.sessionId, 'premise: the worker\'s root owner is the spawner');
      const from = seen.length;
      await worker.prompt('go', [], opts);
      await waitFor(() => of(worker.sessionId, from).some(x => x.e === 'turn_ended'));
      await settle();
      const mine = of(worker.sessionId, from).filter(x => x.e === 'turn_started' || x.e === 'turn_ended');
      assert.deepEqual(mine.map(x => x.e), ['turn_started', 'turn_ended'], JSON.stringify(opts));
      assert.equal(mine[0].conducted, true);
      assert.equal(mine[1].stopReason, 'end_turn');
      actors.push(mine[0].actor);
    }
    assert.deepEqual(actors, [
      { type: 'human' },
      { type: 'conductor', sessionId: owner.sessionId },
      { type: 'system' },
      { type: 'system' },
    ]);
  });

  test('a fork announces the new session as {event:start, cause:fork}, actor human', async () => {
    const name = await project();
    const sid = await seedResumable(name, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second reply' }] } },
    ]);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions', resume: sid });
    await idle(r.body.id);
    const from = seen.length;
    const fk = await api(baseUrl, 'POST', `/api/instances/${r.body.id}/fork`, { userMessageIndex: 1, text: 'second' });
    assert.equal(fk.status, 201, JSON.stringify(fk.body));
    await idle(fk.body.instance.id);
    await settle();
    const launches = of(instances.get(fk.body.instance.id).sessionId, from).filter(x => x.e === 'session_launched');
    assert.deepEqual(launches.map(l => [l.event, l.cause, l.actor.type]), [['start', 'fork', 'human']]);
  });

  test('on a resume whose hydrate emits a status, session_launched precedes every status for the session', async () => {
    // INVARIANT: the launch is announced before this launch's first `status`.
    // The transcript ends on an unanswered AskUserQuestion, so the hydrate sets
    // awaitingUser and emits a status of its own.
    const name = await project();
    const sid = await seedResumable(name, [
      { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'ask me' }] } },
      { type: 'assistant', isSidechain: false, message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'q' }] } }] } },
    ]);
    const order = [];
    const onStatus = s => order.push(['status', s.sessionId, s.awaitingUser]);
    const onLaunch = a => order.push(['launch', a.sessionId]);
    instances.on('status', onStatus);
    instances.on('session_launched', onLaunch);
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions', resume: sid });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await idle(r.body.id);
      await settle();
      const publicId = instances.get(r.body.id).sessionId;
      const mine = order.filter(e => e[1] === publicId);
      assert.ok(mine.some(e => e[0] === 'status' && e[2]), 'premise: the hydrate emitted a status carrying the ask');
      assert.equal(mine[0][0], 'launch', `the launch comes first, got ${JSON.stringify(mine.slice(0, 3))}`);
      assert.equal(mine.filter(e => e[0] === 'launch').length, 1);
    } finally {
      instances.off('status', onStatus);
      instances.off('session_launched', onLaunch);
    }
  });
});
