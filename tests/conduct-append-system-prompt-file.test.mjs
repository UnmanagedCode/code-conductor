// The conductor's composed role doc is delivered via `claude
// --append-system-prompt-file` at spawn — the doc is written to one fixed path
// in the app store and rewritten on every spawn AND resume (the unified
// Instance.launch → spawn path). A non-conductor instance carries no such flag.
// Inspects the frozen launch argv (`inst._spawnArgv`) with the in-process
// launcher, exactly like ollama-spawn.test.mjs, plus the file on disk.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
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

// Records the on-disk state of the prompt file SYNCHRONOUSLY at the instant
// Instance.spawn() hands the frozen argv to the launcher — i.e. the moment the
// real CLI process would start and read the file (exactly once, at arg-parse
// time). Observing after the spawn HTTP response resolves is too late: that is
// after `await inst.launch()` returns, by which point a write issued after
// spawn() has already landed and looks identical to a correct one.
class RecordingLauncher extends InProcessClaudeLauncher {
  constructor() { super(); this.seen = []; }
  launch(opts) {
    const i = opts.args.indexOf('--append-system-prompt-file');
    const p = i >= 0 ? opts.args[i + 1] : null;
    this.seen.push({
      path: p,
      exists: p ? existsSync(p) : false,
      content: p && existsSync(p) ? readFileSync(p, 'utf8') : null,
    });
    return super.launch(opts);
  }
}

test('the prompt file is on disk and current AT the moment the process is launched', async () => {
  // Ordering guard. A mutant that keeps a valid path in argv but performs the
  // write after spawn() — still awaited inside launch() — is invisible to
  // every other test here, yet in production the CLI would open an absent file
  // on the first spawn and a stale one on every spawn after, booting a
  // conductor with the wrong role prompt while looking perfectly healthy.
  const rec = new RecordingLauncher();
  const ctx2 = await bootServer({ scenarioPath: SCENARIO_WS, claudeLauncher: rec });
  try {
    await api(ctx2.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const target = conductPromptPath();
    // Start from no file at all, so "wrote after spawn" cannot hide behind a
    // leftover from an earlier run.
    await fs.rm(target, { force: true });

    const r = await api(ctx2.baseUrl, 'POST', '/api/instances', {
      project: '.conduct', model: 'claude-haiku-4-5', temp: false, mode: 'bypassPermissions',
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx2.instances.get(id)?.status === 'idle');

    assert.equal(rec.seen.length, 1, 'one launch observed');
    assert.equal(rec.seen[0].path, target);
    assert.equal(rec.seen[0].exists, true,
      'prompt file must already exist when the process is launched');
    assert.equal(rec.seen[0].content, await composeCurrentConduct(),
      'file content at launch time is the freshly composed doc');

    // Second half: the STALE variant. Change the selection and respawn — the
    // content visible at launch time must be the NEW doc, not the previous
    // spawn's. A post-spawn write passes the first half on a warm file but
    // fails here, because at launch time the file still holds the old doc.
    await ctx2.instances.get(id).kill({ graceMs: 200 });
    await waitFor(() => !ctx2.instances.get(id)?.proc);
    await setSelection(['canonical-workflow']);
    await ctx2.instances.respawn(id);
    await waitFor(() => ctx2.instances.get(id)?.status === 'idle');

    assert.equal(rec.seen.length, 2, 'relaunch observed');
    assert.equal(rec.seen[1].exists, true);
    assert.doesNotMatch(rec.seen[1].content, /## Worker lifecycle/,
      'at launch time the file already reflects the narrowed selection');
    assert.match(rec.seen[1].content, /## Canonical workflow/);
    assert.equal(rec.seen[1].content, await composeCurrentConduct());
  } finally {
    await ctx2.instances.shutdown();
    await ctx2.close();
  }
});
