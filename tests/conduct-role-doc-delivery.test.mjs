// The conductor's composed role doc is delivered over the MESSAGES stream: it
// is written to `.conduct/CONVENTIONS.md` and reaches the session through that
// dir's `CLAUDE.md` `@CONVENTIONS.md` import. No append-system-prompt flag is
// passed to any instance (a translation proxy in front of a non-Anthropic
// backend can drop the extra `system` block those flags produce). The doc is
// rewritten on every spawn AND resume (the unified Instance.launch → spawn
// path). Inspects the frozen launch argv (`inst._spawnArgv`) with the
// in-process launcher, exactly like ollama-spawn.test.mjs, plus the files on disk.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { composeCurrentConduct, setSelection } from '../src/conductorConventions.ts';
import { conductConventionsPath, conductProjectPath } from '../src/conduct.ts';
import { orchStoreRoot, projectsRoot } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function spawnConductor({ temp = true } = {}) {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: '.conduct', model: 'claude-haiku-4-5', temp, mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201);
  await waitFor(() => instances.get(r.body.id)?.status === 'idle');
  return r.body.id;
}

test('a conductor launch carries NEITHER append-system-prompt flag', async () => {
  const id = await spawnConductor();
  const argv = instances.get(id)._spawnArgv;
  // Exact-element indexOf, NOT a substring scan: `--append-system-prompt-file`
  // must not hide behind a `--append-system-prompt` search, and vice versa.
  // Passing either would put the doc back on the channel a translation proxy
  // can drop — the whole point of the change.
  assert.equal(argv.indexOf('--append-system-prompt-file'), -1,
    'the by-path flag must not be passed');
  assert.equal(argv.indexOf('--append-system-prompt'), -1,
    'the by-value flag must not be passed');
});

test('spawning a conductor writes the composed doc to .conduct/CONVENTIONS.md', async () => {
  await spawnConductor();

  const target = conductConventionsPath();
  assert.equal(target, path.join(projectsRoot(), '.conduct', 'CONVENTIONS.md'),
    'the doc lives in the conductor project dir');

  // Content equality, not mere existence — this is the assertion that kills a
  // mutant writing a truncated / empty / wrong document.
  const onDisk = await fs.readFile(target, 'utf8');
  assert.equal(onDisk, await composeCurrentConduct(), 'file content is the composed conductor doc');
  assert.match(onDisk, /# Conductor role/);
  assert.match(onDisk, /## Worker lifecycle/);

  // The import that carries it must be in place.
  const claudeMd = await fs.readFile(path.join(conductProjectPath(), 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.split('\n').some(l => l.trim() === '@CONVENTIONS.md'),
    '.conduct/CLAUDE.md imports the doc');

  // Kills a mutant that keeps writing the retired store artefact.
  assert.equal(existsSync(path.join(orchStoreRoot(), 'conductor-prompt.md')), false,
    'the retired <store>/conductor-prompt.md must not be written');
});

test('a normal-project instance triggers no materialization', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'plain' });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'plain', model: 'claude-haiku-4-5', temp: true,
  });
  assert.equal(r.status, 201);
  await waitFor(() => instances.get(r.body.id)?.status === 'idle');

  const argv = instances.get(r.body.id)._spawnArgv;
  assert.equal(argv.indexOf('--append-system-prompt-file'), -1);
  assert.equal(argv.indexOf('--append-system-prompt'), -1);
  // Negative control: a non-conductor launch must not materialize the doc (nor
  // create `.conduct/` as a side effect).
  assert.equal(existsSync(conductConventionsPath()), false,
    'no conductor doc written for a plain-project instance');
});

test('resume rewrites the doc in place — same path, new content after a selection change', async () => {
  // temp:false so the instance survives exit in byId and stays respawnable.
  const id = await spawnConductor({ temp: false });

  const target = conductConventionsPath();
  const firstDoc = await fs.readFile(target, 'utf8');
  assert.match(firstDoc, /## Worker lifecycle/, 'default selection present on first spawn');

  // Wind the process down, then narrow the selection and respawn (--resume).
  await instances.get(id).kill({ graceMs: 200 });
  await waitFor(() => !instances.get(id)?.proc);
  await setSelection(['canonical-workflow']);
  await instances.respawn(id);
  await waitFor(() => instances.get(id)?.status === 'idle');

  // Content pins that resume actually recomposes. Asserting only that the file
  // still exists at the same path would survive a mutant that materializes on
  // fresh spawn only and never on resume.
  const secondDoc = await fs.readFile(target, 'utf8');
  assert.doesNotMatch(secondDoc, /## Worker lifecycle/, 'dropped convention gone after resume');
  assert.match(secondDoc, /## Canonical workflow/, 'kept convention still present');
  assert.notEqual(secondDoc, firstDoc, 'doc was recomposed on resume');
});

// Records the on-disk state of the doc and its import SYNCHRONOUSLY at the
// instant Instance.spawn() hands the frozen argv to the launcher — i.e. the
// moment the real CLI process would start and read its CLAUDE.md. Observing
// after the spawn HTTP response resolves is too late: that is after
// `await inst.launch()` returns, by which point a write issued after spawn()
// has already landed and looks identical to a correct one.
class RecordingLauncher extends InProcessClaudeLauncher {
  constructor() { super(); this.seen = []; }
  launch(opts) {
    const doc = conductConventionsPath();
    const claudeMd = path.join(conductProjectPath(), 'CLAUDE.md');
    this.seen.push({
      exists: existsSync(doc),
      content: existsSync(doc) ? readFileSync(doc, 'utf8') : null,
      imported: existsSync(claudeMd)
        && readFileSync(claudeMd, 'utf8').split('\n').some(l => l.trim() === '@CONVENTIONS.md'),
    });
    return super.launch(opts);
  }
}

test('the doc and the import are correct AT the moment the process is launched', async () => {
  // Ordering guard. A mutant that materializes AFTER spawn() — still awaited
  // inside launch() — is invisible to every other test here, yet in production
  // the CLI would read an absent doc on the first spawn and a stale one on
  // every spawn after, booting a conductor with the wrong role prompt while
  // looking perfectly healthy.
  const rec = new RecordingLauncher();
  const ctx2 = await bootServer({ scenarioPath: SCENARIO_WS, claudeLauncher: rec });
  try {
    await api(ctx2.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    // Start from no doc at all, so "wrote after spawn" cannot hide behind a
    // leftover from an earlier run.
    await fs.rm(conductConventionsPath(), { force: true });

    const r = await api(ctx2.baseUrl, 'POST', '/api/instances', {
      project: '.conduct', model: 'claude-haiku-4-5', temp: false, mode: 'bypassPermissions',
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx2.instances.get(id)?.status === 'idle');

    assert.equal(rec.seen.length, 1, 'one launch observed');
    assert.equal(rec.seen[0].exists, true,
      'the doc must already exist when the process is launched');
    assert.equal(rec.seen[0].content, await composeCurrentConduct(),
      'doc content at launch time is the freshly composed document');
    assert.equal(rec.seen[0].imported, true,
      'the CLAUDE.md import must already be in place at launch time');

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
      'at launch time the doc already reflects the narrowed selection');
    assert.match(rec.seen[1].content, /## Canonical workflow/);
    assert.equal(rec.seen[1].content, await composeCurrentConduct());
  } finally {
    await ctx2.instances.shutdown();
    await ctx2.close();
  }
});
