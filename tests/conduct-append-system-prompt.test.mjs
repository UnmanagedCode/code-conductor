// The conductor's composed role doc is delivered via `claude
// --append-system-prompt` at spawn — freshly recomposed on every spawn AND
// resume (the unified Instance.launch → spawn path). A non-conductor instance
// carries no such flag. Inspects the frozen launch argv (`inst._spawnArgv`)
// with the in-process launcher, exactly like ollama-spawn.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { composeCurrentConduct, setSelection } from '../src/conductorConventions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Value passed to --append-system-prompt in a frozen launch argv, or null.
function appendedPrompt(argv) {
  const i = argv.indexOf('--append-system-prompt');
  return i >= 0 ? argv[i + 1] : null;
}

test('a .conduct instance is launched with --append-system-prompt = the composed doc', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: '.conduct', model: 'claude-haiku-4-5', temp: true, mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201);
  await waitFor(() => instances.get(r.body.id)?.status === 'idle');

  const argv = instances.get(r.body.id)._spawnArgv;
  const injected = appendedPrompt(argv);
  assert.ok(injected, '--append-system-prompt present for .conduct');
  assert.equal(injected, await composeCurrentConduct(), 'injected text is the composed conductor doc');
  // Sanity: it really is the role prompt (core + a default-on convention).
  assert.match(injected, /# Conductor role/);
  assert.match(injected, /## Worker lifecycle/);
});

test('a normal-project instance carries no --append-system-prompt', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'plain' });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'plain', model: 'claude-haiku-4-5', temp: true,
  });
  assert.equal(r.status, 201);
  await waitFor(() => instances.get(r.body.id)?.status === 'idle');

  assert.equal(appendedPrompt(instances.get(r.body.id)._spawnArgv), null);
});

test('resume recomposes the doc — a selection change lands on respawn, not just fresh spawn', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  // temp:false so the instance survives exit in byId and stays respawnable.
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: '.conduct', model: 'claude-haiku-4-5', temp: false, mode: 'bypassPermissions',
  });
  const id = r.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Fresh spawn reflects the default all-on selection.
  const first = appendedPrompt(instances.get(id)._spawnArgv);
  assert.match(first, /## Worker lifecycle/, 'default selection present on first spawn');

  // Wind the process down, then narrow the selection and respawn (--resume).
  await instances.get(id).kill({ graceMs: 200 });
  await waitFor(() => !instances.get(id)?.proc);
  await setSelection(['canonical-workflow']);
  await instances.respawn(id);
  await waitFor(() => instances.get(id)?.status === 'idle');

  const second = appendedPrompt(instances.get(id)._spawnArgv);
  assert.ok(second, '--append-system-prompt present on resume');
  assert.doesNotMatch(second, /## Worker lifecycle/, 'dropped convention gone after resume');
  assert.match(second, /## Canonical workflow/, 'kept convention still present');
  assert.notEqual(second, first, 'doc was recomposed on resume');
});
