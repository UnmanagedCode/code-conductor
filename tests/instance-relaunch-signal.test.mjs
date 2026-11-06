// The manager's `session_relaunched` event: emitted once per launch that
// re-enters an existing session (resume, respawn, ...), never for a fresh
// session. The playbook gate turns it into a `resume` ledger row.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, settle } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

describe('session_relaunched', () => {
  let ctx, baseUrl, instances, prevScenario, relaunched;
  const RESUME_SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-resume.json');

  before(async () => {
    ctx = await bootServer({});
    ({ baseUrl, instances } = ctx);
    prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = RESUME_SCENARIO;
    relaunched = [];
    instances.on('session_relaunched', arg => relaunched.push(arg));
  });
  after(async () => {
    await ctx.close();
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  });

  let n = 0;
  async function project() {
    const name = `relaunch-signal-${++n}`;
    await api(baseUrl, 'POST', '/api/projects', { name });
    return name;
  }

  async function seedResumable(name) {
    const sid = `${(n + 0x100).toString(16).padStart(8, '0')}-2222-3333-4444-555555555555`;
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, name)));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    return sid;
  }

  const idle = id => waitFor(() => instances.get(id).status === 'idle');

  test('a fresh create emits no session_relaunched', async () => {
    const name = await project();
    const before = relaunched.length;
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await idle(r.body.id);
    await settle();
    assert.equal(relaunched.length, before);
  });

  test('create({resume}) emits exactly one, naming the public sessionId', async () => {
    const name = await project();
    const sid = await seedResumable(name);
    const before = relaunched.length;
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions', resume: sid });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await idle(r.body.id);
    await settle();
    const fresh = relaunched.slice(before);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].sessionId, instances.get(r.body.id).sessionId);
  });

  test('kill + respawn emits exactly one, naming the public sessionId', async () => {
    const name = await project();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    await idle(id);
    const inst = instances.get(id);
    const publicId = inst.sessionId;
    // Send a prompt so the session has a conversation to resume.
    await inst.prompt('hello');
    await waitFor(() => inst.status === 'idle');
    const before = relaunched.length;
    await inst.kill({ graceMs: 50 });
    await waitFor(() => ['exited', 'crashed'].includes(instances.get(id).status));
    assert.equal(relaunched.length, before, 'the kill alone is not a relaunch');
    await instances.respawn(id);
    await settle();
    const fresh = relaunched.slice(before);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].sessionId, publicId);
  });

  test('a conducted worker\'s event carries conducted:true, an ordinary one conducted:false', async () => {
    const name = await project();
    const sid = await seedResumable(name);
    const plain = await api(baseUrl, 'POST', '/api/instances', { project: name, mode: 'bypassPermissions', resume: sid });
    await idle(plain.body.id);
    const sid2 = await seedResumable(await project());
    const name2 = `relaunch-signal-${n}`;
    const before = relaunched.length;
    const conducted = await instances.create({ project: name2, mode: 'bypassPermissions', resume: sid2, conducted: true });
    await idle(conducted.id);
    await settle();
    const ev = relaunched.slice(before).find(e => e.sessionId === conducted.sessionId);
    assert.ok(ev, 'the conducted resume emitted');
    assert.equal(ev.conducted, true);
    const plainEv = relaunched.find(e => e.sessionId === instances.get(plain.body.id).sessionId);
    assert.equal(plainEv?.conducted, false);
  });
});
