// 0033 moves the retired session-root trees aside. The rule it has to obey is
// MOVE, NEVER DELETE: a session root was the CLI's working directory, so a
// worker could write into it, and a push that failed left the local copy holding
// content the system does not have. Those bytes exist nowhere else.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './helpers.mjs';
import { run, name } from '../migrations/0034-retire-session-roots.mjs';

describe('migration 0034: retire the session roots', () => {
  let root;
  beforeEach(async () => { root = await mkdtemp('cc-m33-'); });
  afterEach(async () => { await rmrf(root); });

  const systems = () => path.join(root, '.code-conductor', 'systems');
  const seed = async (id, files) => {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(systems(), id, 'sessions', rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, body);
    }
  };
  const listRetired = async (id) =>
    (await fs.readdir(path.join(systems(), id)).catch(() => []))
      .filter(n => n.startsWith('retired-session-roots-'));

  // PINS THE WHOLE POINT: the tree is moved, its CONTENT survives byte-for-byte,
  // and the live path is gone. A migration that deleted would pass a "the live
  // path is gone" assertion alone.
  test('moves the tree aside with its content intact, and reports where', async () => {
    await seed('box', {
      'app/CLAUDE.md': 'pulled\n',
      'app/uncommitted.txt': 'EDITS THE SYSTEM NEVER GOT\n',
      'app.manifest.json': '{"remoteId":null}',
    });
    const logs = [];
    const r = await run({ root, log: (l) => logs.push(l) });

    assert.equal(r.applied, true);
    assert.deepEqual(r.summary, { moved: 1, systems: ['box'] });
    assert.equal(await fs.stat(path.join(systems(), 'box', 'sessions')).then(() => true, () => false), false);

    const [retired] = await listRetired('box');
    assert.ok(retired, 'nothing was moved aside');
    const base = path.join(systems(), 'box', retired);
    assert.equal(await fs.readFile(path.join(base, 'app', 'uncommitted.txt'), 'utf8'),
      'EDITS THE SYSTEM NEVER GOT\n');
    // The manifest sidecars sit BESIDE the roots inside `sessions/`, so moving
    // the directory has to take them too.
    assert.equal(await fs.readFile(path.join(base, 'app.manifest.json'), 'utf8'), '{"remoteId":null}');
    assert.ok(logs.some(l => l.includes(retired)), 'the operator was not told where it went');
    assert.ok(logs.some(l => l.includes('MOVED ASIDE')), 'the log does not say it was kept');
  });

  // PINS: every system with a tree is moved, not just the first.
  test('moves every system that has one', async () => {
    await seed('a', { 'p/x': '1' });
    await seed('b', { 'p/x': '2' });
    await fs.mkdir(path.join(systems(), 'c'), { recursive: true });   // registered, never used

    const r = await run({ root, log: () => {} });
    assert.equal(r.summary.moved, 2);
    assert.deepEqual(r.summary.systems.sort(), ['a', 'b']);
    assert.equal((await listRetired('c')).length, 0, 'a system with no tree was touched');
  });

  // PINS IDEMPOTENCE: a second run is a no-op and does NOT move the already
  // retired tree again — the probe is the live path, not the retired one.
  test('a second run is a no-op and does not re-move what it moved', async () => {
    await seed('box', { 'p/x': '1' });
    assert.equal((await run({ root, log: () => {} })).applied, true);
    const after = await listRetired('box');

    assert.equal((await run({ root, log: () => {} })).applied, false);
    assert.deepEqual(await listRetired('box'), after, 'the retired tree was moved again');
  });

  // PINS: an install with no systems at all — every local-only install — is a
  // fast no-op rather than an error that aborts the boot.
  test('an install with no systems directory applies nothing', async () => {
    assert.deepEqual(await run({ root, log: () => {} }), { applied: false });
  });

  // PINS: a tree that cannot be moved is NAMED and the boot continues. It is
  // orphaned either way, and refusing to start over it helps nobody — a
  // migration that throws aborts the boot.
  test('a tree that cannot be moved is reported, not thrown', async () => {
    await seed('box', { 'p/x': '1' });
    await seed('ok', { 'p/x': '2' });
    // Make the rename fail by making the PARENT unwritable.
    await fs.chmod(path.join(systems(), 'box'), 0o500);
    const logs = [];
    try {
      const r = await run({ root, log: (l) => logs.push(l) });
      assert.equal(r.applied, true, 'the other system was still moved');
      assert.deepEqual(r.summary.systems, ['ok']);
      assert.ok(logs.some(l => l.includes('could not move')), logs.join(' | '));
    } finally {
      await fs.chmod(path.join(systems(), 'box'), 0o700);
    }
  });

  test('the module names itself for the log line', () => {
    assert.equal(name, '0034-retire-session-roots');
  });
});
