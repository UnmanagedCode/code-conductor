// THE D10 GATE: a provider that advertises no mirror is exactly today's system.
//
// P7 widens the session root from the image of one project tree to the image of
// whatever the provider says it mirrors. The overwhelmingly common answer is
// "nothing", and that answer has to cost nothing — not a frame, not a byte of
// different geometry, not a different code path taken by accident.
//
// Checked at four layers rather than asserted once: the WIRE (no frame goes
// out), the GEOMETRY (offset zero, cwd === root, empty exclude), the WALK
// (unchanged anchor and targets — pinned differentially in
// tests/systems-session-root.test.mjs), and the POLICY (nothing can be
// excluded, so the excluded branch is unreachable).
//
// D-P7-10 form: the geometry assertion takes FORM 3 — the three facts are
// asserted directly as independent invariants (offset, cwd === root, the map's
// exclude list) and the layout is enumerated as hand-written literals. Nothing
// here compares against a constant lifted from the new implementation.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, localSystem, systemById } from '../src/systems/registry.ts';
import { composeSessionRoot } from '../src/systems/sessionRoot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(__dirname, 'fixtures', 'recordingProvider.mjs');

async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// The allow-list entries this layout names, plus content that must not be
// pulled, written by hand so the expected layout below is a literal and not a
// snapshot.
async function seedTree(root) {
  const w = async (rel, body) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  };
  await w('CLAUDE.md', '@CONVENTIONS.md\nproject notes\n');
  await w('CONVENTIONS.md', 'rules\n');
  await w('.claude/settings.json', '{"a":1}');
  await w('.claude/skills/deploy/SKILL.md', 'deploy skill');
  await w('ONLY-ON-SYSTEM.txt', 'system side');
  await w('src/index.js', 'console.log(1)\n');
  return root;
}

const listTree = async (dir) => {
  const out = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r); else out.push(r);
    }
  };
  await walk('');
  return out.sort();
};

describe('a provider that advertises no mirror', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS: cc never puts a `describeRemote` frame on the wire when the provider
  // does not advertise `remoteDescriptors`. A capability gate asserted from
  // cc's side would pass whether or not the frame stayed home; this is the
  // bytes that crossed the pipe.
  //
  // NOT CLAIMING: that the rest of the traffic is unchanged. The existing suite
  // under `npm run gate:systems` is what asserts that.
  test('no describeRemote frame is ever sent', async () => {
    const rec = path.join(await mkdtemp('cc-wire-'), 'frames.jsonl');
    const tree = await seedTree(await fs.realpath(await mkdtemp('cc-remote-')));
    await addSystem({ id: 'box', label: 'box', launch: ['node', RECORDER, '--record', rec] });
    const sys = await systemById('box', null, 'test');
    assert.equal(sys.handshake.capabilities.remoteDescriptors, false);

    await composeSessionRoot({ system: sys, systemId: 'box', systemPath: tree, project: 'app' });

    const frames = await wire(rec);
    assert.ok(frames.length > 0, 'the recorder really saw traffic');
    assert.deepEqual(frames.filter(f => f.type === 'describeRemote'), []);
  });

  // PINS the three geometry facts D-P7-10 form 3 names, directly: the offset is
  // zero, the CLI's cwd IS the session root, and the exclude list the path map
  // is built on is empty. The layout is enumerated by hand.
  //
  // NOT CLAIMING: that no string anywhere changed. D-P7-9 records one
  // deliberate refusal-wording change on this path.
  test('the composed root has offset zero, cwd === root, and no exclusions', async () => {
    const tree = await seedTree(await fs.realpath(await mkdtemp('cc-remote-')));
    const remote = await bindRemoteSystem();
    const composed = await composeSessionRoot({
      system: await systemById(remote.id, null, 'test'),
      systemId: remote.id, systemPath: tree, project: 'app',
    });

    assert.equal(composed.mirror.offset, '');
    assert.equal(composed.cwd, composed.root);
    assert.equal(composed.mirror.mirrorRoot, tree);
    assert.deepEqual(composed.mirror.exclude, []);
    assert.deepEqual(composed.notes, []);

    // The layout, written out rather than snapshotted.
    assert.deepEqual(await listTree(composed.root), [
      '.claude/settings.json',
      '.claude/skills/deploy/SKILL.md',
      'CLAUDE.md',
      'CONVENTIONS.md',
    ].sort());
    assert.equal(await fs.readFile(path.join(composed.root, 'CLAUDE.md'), 'utf8'),
      '@CONVENTIONS.md\nproject notes\n');
    assert.equal(await fs.readFile(path.join(composed.root, 'CONVENTIONS.md'), 'utf8'), 'rules\n');
  });

  // PINS: cc's own machine advertises nothing, unconditionally — which is what
  // keeps `npm run gate:systems` at three capability configurations rather than
  // four. The gate varies the LOCAL system's provider; if that provider could
  // advertise a mirror, the fallback would need its own run.
  //
  // NOT CLAIMING: anything about what a provider standing in for `local` under
  // CC_LOCAL_SYSTEM_PROVIDER advertises — this asserts the in-process
  // implementation, which is what the gate's fourth configuration would test.
  test('the local system advertises no mirror', async () => {
    const { LocalSystem } = await import('../src/systems/localSystem.ts');
    assert.deepEqual(await new LocalSystem().mirror(), { mirrorRoot: null, exclude: [] });
    // And the live handle the registry hands out answers the same way when it
    // is the in-process one.
    const live = localSystem();
    if (live instanceof LocalSystem) {
      assert.deepEqual(await live.mirror(), { mirrorRoot: null, exclude: [] });
    }
  });
});
