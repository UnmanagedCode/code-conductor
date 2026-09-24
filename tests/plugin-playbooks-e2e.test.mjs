// Plugin-contributed playbooks end to end: real plugin projects discovered and
// enabled over REST, a real conductor at `enforce`, and MCP calls through the
// router with the fake claude engine. What the pure tests in
// tests/plugin-playbooks.test.mjs cannot reach: server.ts's provider wiring, the
// host's enable/disable driving the definitions every governed call reads, the
// ledger binding surviving a disable, and spawn-time role resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bootServer, api, waitFor, instForSession, seedSessionJsonl, registerLocalProject,
} from './helpers.mjs';
import { ledgerFile, readEvents, foldProjection } from '../src/playbookLedger.ts';
import { localPlace } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-ws.json');

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await registerLocalProject(name, repoPath);
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

// `acme` owns a role and a playbook whose entry stage pins that role.
const ACME_RELEASE = {
  id: 'release', name: 'Acme release', description: 'Plan a release under the captain.',
  entryStages: ['plan'],
  stages: {
    plan: { tools: { spawn_instance: { pin: { model: 'acme/captain' } } } },
  },
  transitions: [],
};
// `bee` pins a role owned by a DIFFERENT plugin.
const BEE_FLOW = {
  id: 'flow', name: 'Bee flow', description: "Borrows acme's captain.",
  entryStages: ['start'],
  stages: {
    start: { tools: { spawn_instance: { pin: { model: 'acme/captain' } } } },
  },
  transitions: [],
};

async function writePlugin(projectsRoot, { id, roles, playbooks }) {
  const dir = path.join(projectsRoot, id);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    id, name: id, version: '1.0.0', pluginApi: 1,
    ...(roles ? { roles } : {}),
    playbooks: playbooks.map(p => ({ slug: p.id, file: `${p.id}.json` })),
  };
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest));
  for (const p of playbooks) await fs.writeFile(path.join(dir, `${p.id}.json`), JSON.stringify(p));
  await registerLocalProject(id, dir);
}

let nextRpcId = 1;

async function setup() {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  await makeRealRepo(ctx.projectsRoot, 'demo');
  await writePlugin(ctx.projectsRoot, {
    id: 'acme',
    roles: [{ slug: 'captain', name: 'Captain', binding: { kind: 'tier', tier: 'powerful' } }],
    playbooks: [ACME_RELEASE],
  });
  await writePlugin(ctx.projectsRoot, { id: 'bee', playbooks: [BEE_FLOW] });
  assert.equal((await api(ctx.baseUrl, 'POST', '/api/plugins/rescan')).status, 200);
  for (const id of ['acme', 'bee']) {
    const r = await api(ctx.baseUrl, 'POST', `/api/plugins/${id}/enable`);
    assert.equal(r.status, 200, `enable ${id}: ${JSON.stringify(r.body)}`);
  }
  await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const spawned = await api(ctx.baseUrl, 'POST', '/api/instances', {
    project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'enforce',
  });
  assert.equal(spawned.status, 201, `conductor spawn failed: ${JSON.stringify(spawned.body)}`);
  const conductorId = spawned.body.id;
  await waitFor(() => ctx.instances.get(conductorId)?.status === 'idle');

  // The raw result, hard errors included — the cross-plugin pin case expects one.
  async function rawCall(name, args, caller = conductorId) {
    const res = await fetch(`${ctx.baseUrl}/mcp${caller ? `?caller=${encodeURIComponent(caller)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(body.result, `tools/call ${name} returned no result: ${JSON.stringify(body)}`);
    return body.result;
  }
  async function call(name, args, caller) {
    const result = await rawCall(name, args, caller);
    assert.notEqual(result.isError, true, `tools/call ${name} hard-errored: ${result.content?.[0]?.text}`);
    return JSON.parse(result.content[0].text);
  }

  return {
    ...ctx,
    rawCall,
    call: (name, args) => call(name, args),
    callUngoverned: (name, args) => call(name, args, null),
    async setPlugin(id, enabled) {
      const r = await api(ctx.baseUrl, 'POST', `/api/plugins/${id}/${enabled ? 'enable' : 'disable'}`);
      assert.equal(r.status, 200, `${enabled ? 'enable' : 'disable'} ${id}: ${JSON.stringify(r.body)}`);
    },
    async spawnRelease() {
      const out = await call('spawn_instance', {
        project: 'demo', playbook: 'acme/release', stage: 'plan', mode: 'bypassPermissions',
      });
      assert.ok(out.sessionId, `the plugin-playbook spawn must succeed: ${JSON.stringify(out)}`);
      await waitFor(() => instForSession(ctx.instances, out.sessionId)?.sessionId);
      return out;
    },
    events: () => readEvents(ledgerFile()),
  };
}

function assertNamesAcme(reason) {
  assert.match(reason, /plugin 'acme'/);
  assert.match(reason, /re-enabl/);
}

test('a plugin playbook is listed, spawnable under its own role pin, survives a disable with its binding intact, and flags the preferred selection', async () => {
  const t = await setup();
  try {
    const listed = await t.call('list_playbooks', {});
    const release = listed.playbooks.find(p => p.id === 'acme/release');
    assert.ok(release, `acme/release must be listed: ${JSON.stringify(listed)}`);
    assert.equal(release.plugin, 'acme');
    assert.equal(listed.playbooks.find(p => p.id === 'relay')?.plugin, undefined, 'a built-in carries no plugin');

    const w = await t.spawnRelease();
    const spawns = (await t.events()).filter(e => e.kind === 'spawn' && e.sessionId === w.sessionId);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].playbook, 'acme/release');
    const bindingOf = async () => {
      const st = foldProjection(await t.events()).bySession.get(w.sessionId);
      return { playbook: st.playbook, stage: st.stage, stageHistory: st.stageHistory };
    };
    const before = await bindingOf();

    // Preferred while loaded; the Settings payload labels plugin playbooks.
    const put = await api(t.baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook',
      { defaultPlaybook: { mode: 'playbook', id: 'acme/release' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    let settings = (await api(t.baseUrl, 'GET', '/api/settings/conventions/conductor')).body;
    assert.equal(settings.playbooks.find(p => p.id === 'acme/release')?.plugin, 'acme');
    assert.equal(settings.defaultPlaybookMissing, null);

    await t.setPlugin('acme', false);

    const refused = await t.call('send_prompt', { sessionId: w.sessionId, text: 'go', stage: 'plan' });
    assert.equal(refused.ok, false, `send_prompt must be refused: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, 'PLAYBOOK_UNKNOWN');
    assertNamesAcme(refused.reason);

    // The targeted playbook_state names a worker, so under enforce it is itself
    // governed and meets the same refusal. The handler's own report is what an
    // ungoverned caller (no conductor behind `?caller=`) reads.
    const governedState = await t.call('playbook_state', { sessionId: w.sessionId });
    assert.equal(governedState.code, 'PLAYBOOK_UNKNOWN');
    assertNamesAcme(governedState.reason);
    const state = await t.callUngoverned('playbook_state', { sessionId: w.sessionId });
    assert.equal(state.tracked, true);
    assert.equal(state.playbookMissing, 'acme/release');
    assertNamesAcme(state.reason);

    settings = (await api(t.baseUrl, 'GET', '/api/settings/conventions/conductor')).body;
    assert.deepEqual(settings.defaultPlaybook, { mode: 'playbook', id: 'acme/release' }, 'the selection is retained');
    assert.equal(settings.defaultPlaybookMissing?.id, 'acme/release');
    assertNamesAcme(settings.defaultPlaybookMissing.reason);
    assert.equal(settings.playbooks.find(p => p.id === 'bee/flow')?.plugin, 'bee');

    // A playbook pinning a DISABLED plugin's role stays listed: pins resolve
    // only at spawn, where the handler's own unknown-model error fires.
    const stillListed = await t.call('list_playbooks', {});
    assert.ok(stillListed.playbooks.some(p => p.id === 'bee/flow'), 'bee/flow must still be listed');
    const beeSpawn = await t.rawCall('spawn_instance', {
      project: 'demo', playbook: 'bee/flow', stage: 'start', mode: 'bypassPermissions',
    });
    assert.equal(beeSpawn.isError, true, `the spawn must hard-error: ${JSON.stringify(beeSpawn)}`);
    assert.match(beeSpawn.content[0].text, /unknown model 'acme\/captain'/);
    assert.deepEqual((await t.events()).filter(e => e.kind === 'spawn' && e.playbook === 'bee/flow'), [],
      'a failed spawn ledgers nothing');

    await t.setPlugin('acme', true);

    const ok = await t.call('send_prompt', { sessionId: w.sessionId, text: 'go', stage: 'plan' });
    assert.notEqual(ok.ok, false, `re-enable restores governance on the same session: ${JSON.stringify(ok)}`);
    assert.deepEqual(await bindingOf(), before, 'the binding is untouched by the disable');
    assert.equal((await t.events()).filter(e => e.kind === 'spawn' && e.sessionId === w.sessionId).length, 1,
      'no second spawn event — nothing was repaired');
  } finally { await t.close(); }
});

test('a resume into a disabled plugin playbook is refused naming the plugin, and succeeds once it is re-enabled', async () => {
  const t = await setup();
  try {
    const w = await t.spawnRelease();
    const backingSessionId = instForSession(t.instances, w.sessionId).backingSessionId;
    await seedSessionJsonl(localPlace(path.join(t.projectsRoot, 'demo')), backingSessionId);
    await t.call('kill_instance', { sessionId: w.sessionId });
    await waitFor(() => !instForSession(t.instances, w.sessionId)?.proc);
    await waitFor(async () => (await t.events()).some(e => e.kind === 'retire' && e.sessionId === w.sessionId));

    await t.setPlugin('acme', false);
    const refused = await t.call('spawn_instance', { resume: w.sessionId });
    assert.equal(refused.ok, false, `the resume must be refused: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, 'PLAYBOOK_UNKNOWN');
    assertNamesAcme(refused.reason);

    await t.setPlugin('acme', true);
    const back = await t.call('spawn_instance', { resume: w.sessionId });
    assert.notEqual(back.ok, false, `the resume must succeed once acme is back: ${JSON.stringify(back)}`);
    assert.equal(back.sessionId, w.sessionId);
    await waitFor(async () => (await t.events()).some(e => e.kind === 'resume' && e.sessionId === w.sessionId));
  } finally { await t.close(); }
});
