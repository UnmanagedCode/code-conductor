// The conductor's composed role doc is delivered via `claude
// --append-system-prompt-file` at spawn — the doc is written to one fixed path
// in the app store and rewritten on every spawn AND resume (the unified
// Instance.launch → spawn path). A non-conductor instance carries no such flag.
// Inspects the frozen launch argv (`inst._spawnArgv`) with the in-process
// launcher, exactly like ollama-spawn.test.mjs, plus the file on disk.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { composeCurrentConduct, setSelection } from '../src/conductorConventions.ts';
import { conductPromptPath } from '../src/conduct.ts';
import { orchStoreRoot } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Value passed to --append-system-prompt-file in a frozen launch argv, or null.
function promptFileArg(argv) {
  const i = argv.indexOf('--append-system-prompt-file');
  return i >= 0 ? argv[i + 1] : null;
}

async function spawnConductor({ temp = true } = {}) {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: '.conduct', model: 'claude-haiku-4-5', temp, mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201);
  await waitFor(() => instances.get(r.body.id)?.status === 'idle');
  return r.body.id;
}

test('a .conduct instance is launched with --append-system-prompt-file, and the file holds the composed doc', async () => {
  const id = await spawnConductor();
  const filePath = promptFileArg(instances.get(id)._spawnArgv);
  assert.ok(filePath, '--append-system-prompt-file present for .conduct');

  // The doc must survive the file hop unchanged — this is the assertion that
  // kills a mutant writing a truncated/empty/wrong document, which a
  // path-presence-only check would happily pass.
  const onDisk = await fs.readFile(filePath, 'utf8');
  assert.equal(onDisk, await composeCurrentConduct(), 'file content is the composed conductor doc');
  // Sanity: it really is the role prompt (core + a default-on convention).
  assert.match(onDisk, /# Conductor role/);
  assert.match(onDisk, /## Worker lifecycle/);
});

test('the by-value --append-system-prompt flag is gone (the two are mutually exclusive)', async () => {
  const id = await spawnConductor();
  const argv = instances.get(id)._spawnArgv;
  // Exact-element indexOf, NOT a substring scan: `--append-system-prompt-file`
  // must not false-positive here. Passing both flags is a hard CLI startup
  // error in production but is silently ignored by the in-process launcher,
  // so this needs its own assertion rather than riding on the test above.
  assert.equal(argv.indexOf('--append-system-prompt'), -1,
    'the by-value flag must not be passed alongside the file flag');
  assert.ok(argv.includes('--append-system-prompt-file'));
});

test('the prompt file lives in the app store, not in .conduct/', async () => {
  const id = await spawnConductor();
  const filePath = promptFileArg(instances.get(id)._spawnArgv);

  assert.equal(filePath, conductPromptPath(), 'argv path is the one canonical store path');
  assert.equal(path.dirname(filePath), orchStoreRoot(), 'file sits directly in the store root');
  // Guards the "this is not a revert of migration 0022" decision at the argv
  // level: nothing conductor-owned may reappear inside the project tree.
  assert.ok(!filePath.includes(`${path.sep}.conduct${path.sep}`),
    'the doc must not live inside the .conduct project dir');
});

test('a normal-project instance carries neither append-system-prompt flag', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'plain' });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'plain', model: 'claude-haiku-4-5', temp: true,
  });
  assert.equal(r.status, 201);
  await waitFor(() => instances.get(r.body.id)?.status === 'idle');

  const argv = instances.get(r.body.id)._spawnArgv;
  assert.equal(promptFileArg(argv), null);
  assert.equal(argv.indexOf('--append-system-prompt'), -1);
});

test('resume rewrites the file in place — same path, new content after a selection change', async () => {
  // temp:false so the instance survives exit in byId and stays respawnable.
  const id = await spawnConductor({ temp: false });

  const firstPath = promptFileArg(instances.get(id)._spawnArgv);
  const firstDoc = await fs.readFile(firstPath, 'utf8');
  assert.match(firstDoc, /## Worker lifecycle/, 'default selection present on first spawn');

  // Wind the process down, then narrow the selection and respawn (--resume).
  await instances.get(id).kill({ graceMs: 200 });
  await waitFor(() => !instances.get(id)?.proc);
  await setSelection(['canonical-workflow']);
  await instances.respawn(id);
  await waitFor(() => instances.get(id)?.status === 'idle');

  const secondPath = promptFileArg(instances.get(id)._spawnArgv);
  assert.ok(secondPath, '--append-system-prompt-file present on resume');
  // Path stability pins the single-fixed-path decision...
  assert.equal(secondPath, firstPath, 'one fixed path — resume does not mint a new file');
  // ...and content pins that resume actually recomposes. Asserting only the
  // path would survive a mutant that never rewrites the file at all.
  const secondDoc = await fs.readFile(secondPath, 'utf8');
  assert.doesNotMatch(secondDoc, /## Worker lifecycle/, 'dropped convention gone after resume');
  assert.match(secondDoc, /## Canonical workflow/, 'kept convention still present');
  assert.notEqual(secondDoc, firstDoc, 'doc was recomposed on resume');
});

test('the file exists and is current before the process is spawned', async () => {
  // Ordering guard: a mutant that materializes AFTER spawn() would leave the
  // real CLI erroring "Append system prompt file not found" at arg-parse time,
  // while the in-process launcher ignores the path entirely. Pin it by
  // checking the file is already on disk and matching the moment the argv is
  // frozen — _spawnArgv is set inside spawn(), after launch() awaited the
  // provider, so a readable matching file here means the write preceded spawn.
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const target = conductPromptPath();
  await fs.rm(target, { force: true });

  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: '.conduct', model: 'claude-haiku-4-5', temp: true, mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  // As soon as the argv is frozen the file must already be there.
  await waitFor(() => inst._spawnArgv !== null);
  const stat = await fs.stat(target);
  assert.ok(stat.isFile(), 'prompt file written before the launch argv was frozen');
  assert.equal(await fs.readFile(target, 'utf8'), await composeCurrentConduct());
});
