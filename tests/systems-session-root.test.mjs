// CRITERION 8, BY EVIDENCE: THERE IS NO SESSION ROOT.
//
// There is no allow-list walk over what a remote session's cc-owned local
// session root contains, and no such root for one to fill: no pulled config
// files, no entry cap, no byte caps, no listing fence, no manifest sidecar, no
// `rankConfigSurface` pinned/capped split, no `find` argv enumerating it. The
// union serves the project's own tree, and no walk decides what a worker may
// see.
//
// THE ABSENCE ITSELF IS THE CLAIM, and it has to be asserted rather than
// assumed: "we deleted the code" is not evidence that nothing composes a root.
// Two independent claims, because either alone can be satisfied by accident:
//
//   1. NOTHING IS ON DISK — no `<store>/systems/<id>/sessions` tree, no
//      manifest sidecar, after a real remote spawn.
//   2. NOTHING IS ON THE WIRE — a recording provider sees ZERO `find` frames.
//      This is the same wire-level proof systems-mirror-fallback uses for
//      `describeRemote`, and it is the stronger of the two: a root composed
//      somewhere unexpected would still have to enumerate the system to fill
//      itself, and the walk's `find` is how it did that.
//
// The recorder is the honest instrument here for the same reason it is there:
// a filesystem assertion can only look where the test thought to look, and the
// wire shows everything cc actually asked the system for.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, 'fixtures', 'recordingProvider.mjs');
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-no-turn.json');

async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

// Every entry under the store, recursively, so an assertion cannot miss a root
// composed at a path this file did not predict.
async function walk(root, prefix = '') {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    out.push(rel);
    if (e.isDirectory()) out.push(...await walk(path.join(root, e.name), rel));
  }
  return out;
}

describe('criterion 8: a remote session composes no session root', () => {
  let ctx, baseUrl, instances, home, n = 0;

  before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
  after(async () => { if (ctx) await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  // A remote project on a RECORDING provider, spawned for real through the REST
  // surface — the same path a user takes.
  async function spawnRemote() {
    const id = `box${++n}`;
    const rec = path.join(await mkdtemp('cc-wire-'), 'frames.jsonl');
    const box = await fs.realpath(await mkdtemp('cc-remote-'));
    const tree = await seedRepo(path.join(box, 'app'));
    // The config surface a walk would pull, all of it present on the system so
    // its absence locally is a fact about cc rather than about the fixture.
    await fs.mkdir(path.join(tree, '.claude', 'skills', 'deploy'), { recursive: true });
    await fs.writeFile(path.join(tree, '.claude', 'settings.json'), '{}\n');
    await fs.writeFile(path.join(tree, '.claude', 'skills', 'deploy', 'SKILL.md'), '# deploy\n');
    await fs.writeFile(path.join(tree, 'CLAUDE.md'), '@CONVENTIONS.md\n');

    await addSystem({ id, label: id, launch: ['node', RECORDER, '--record', rec] });
    assert.equal((await adoptProject('app', tree, { system: id })).ok, true);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    return { id, rec, tree, inst };
  }

  // PINS CLAIM 1: nothing on disk. Asserted over a full walk of the store rather
  // than at one predicted path, and with the CLI's cwd checked against the tree
  // so a root composed somewhere else could not be what the session is using.
  test('the store holds no session root and no manifest after a remote spawn', async () => {
    const s = await spawnRemote();

    assert.equal(s.inst.cwd, s.tree, "the CLI's cwd is not the project's path on its system");
    assert.equal(await exists(path.join(orchStoreRoot(), 'systems', s.id, 'sessions')), false);

    const under = await walk(orchStoreRoot());
    assert.deepEqual(under.filter(p => p.includes('sessions')), [],
      `something composed a session root: ${JSON.stringify(under.filter(p => p.includes('sessions')))}`);
    assert.deepEqual(under.filter(p => p.endsWith('.manifest.json')), [],
      'a manifest sidecar was written');
  });

  // PINS CLAIM 2, and it is the stronger one: ZERO `find` frames on the wire.
  // The allow-list walk enumerated the system's config surface with `find`
  // before pulling it; a root composed anywhere would still have to ask.
  //
  // The control is in the same assertion set: the recorder DID see traffic, so
  // an empty `find` list is a fact about what cc asked for rather than about a
  // provider that was never launched.
  test('a remote spawn sends no find frame — the allow-list walk is gone', async () => {
    const s = await spawnRemote();
    const frames = await wire(s.rec);

    assert.ok(frames.length > 0, 'the recorder saw no traffic at all — the control failed');
    const finds = frames.filter(f => f.type === 'exec'
      && Array.isArray(f.argv) && f.argv[0] === 'find');
    assert.deepEqual(finds, [], `the walk still runs: ${JSON.stringify(finds)}`);

    // AND WHAT IS STILL READ IS ONLY WHAT SHOULD BE. The walk pulled the whole
    // config surface; what is left on this wire under `.claude/` is the two
    // REFUSAL SCANS — `disableAllHooks` and the unenforceable-Bash-rules scan —
    // which read the project's own settings pair THROUGH THE SYSTEM HANDLE
    // because there is no local copy to stat any more (the C7 correction). Two
    // scans over two files is four reads, and no `skills/**` at all: a walk
    // would have taken the skill files too.
    const reads = frames.filter(f => f.type === 'readFile' || f.type === 'readFileBytes');
    const underClaude = reads.filter(f => String(f.path).includes('/.claude/'));
    assert.deepEqual([...new Set(underClaude.map(f => path.basename(String(f.path))))].sort(),
      ['settings.json', 'settings.local.json'],
      `something beyond the refusal scans is reading the config surface: ${JSON.stringify(underClaude)}`);
    assert.deepEqual(reads.filter(f => String(f.path).includes('/skills/')), [],
      'the skill files were pulled — that is the allow-list walk');
  });

  // PINS: the project's own config surface is NOT copied anywhere local, and the
  // file the walk would have skipped is simply part of the tree. The absence of
  // a local copy is what makes "one spelling per path" true.
  test('the config surface stays on the system, with no local copy of it', async () => {
    const s = await spawnRemote();
    for (const rel of ['CLAUDE.md', '.claude/settings.json', '.claude/skills/deploy/SKILL.md']) {
      assert.ok(await exists(path.join(s.tree, rel)), `${rel} is missing from the fixture`);
    }
    const under = await walk(orchStoreRoot());
    assert.deepEqual(under.filter(p => p.endsWith('CLAUDE.md') || p.endsWith('SKILL.md')), [],
      'the config surface was copied into the store');
  });
});
