// 0034 closes the systemPath normalisation hole in records written before the
// write path was fixed. The stored string IS the CLI's working directory, and
// the transcript guard compares `encodeCwd(cwd)` — so `/srv/app/` and
// `/srv/app`, one directory, encoded differently and both got registered.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './helpers.mjs';
import { run, name } from '../migrations/0035-normalize-system-paths.mjs';

describe('migration 0035: normalize stored systemPaths', () => {
  let root;
  beforeEach(async () => { root = await mkdtemp('cc-m34-'); });
  afterEach(async () => { await rmrf(root); });

  const dir = () => path.join(root, '.code-conductor', 'projects');
  const seed = async (project, rec) => {
    await fs.mkdir(path.join(dir(), project), { recursive: true });
    await fs.writeFile(path.join(dir(), project, 'project.json'), JSON.stringify(rec));
  };
  const read = async (project) =>
    JSON.parse(await fs.readFile(path.join(dir(), project, 'project.json'), 'utf8'));

  // PINS the whole point: every shape that is one directory spelled differently
  // is folded to one spelling, and the rest of the record is untouched.
  test('normalises trailing slashes and dot segments, keeping every other field', async () => {
    await seed('a', { system: 'box', remoteId: 'r1', systemPath: '/srv/app/', workspace: 'w' });
    await seed('b', { system: 'box', systemPath: '/srv/./app2' });
    await seed('c', { system: 'box', systemPath: '/srv/x/../proj' });

    const r = await run({ root, log: () => {} });
    assert.equal(r.applied, true);
    assert.equal(r.summary.normalized, 3);
    assert.equal((await read('a')).systemPath, '/srv/app');
    assert.equal((await read('b')).systemPath, '/srv/app2');
    assert.equal((await read('c')).systemPath, '/srv/proj');
    // Nothing else moved.
    assert.equal((await read('a')).remoteId, 'r1');
    assert.equal((await read('a')).workspace, 'w');
  });

  // PINS: `/` is not stripped to ''. The one path where "drop the trailing
  // slash" is wrong.
  test('the filesystem root survives', async () => {
    await seed('a', { system: 'box', systemPath: '/' });
    assert.equal((await run({ root, log: () => {} })).applied, false);
    assert.equal((await read('a')).systemPath, '/');
  });

  // PINS: a local project — no systemPath — is left alone, and an unparsable or
  // absent record does not abort the boot.
  test('records with no systemPath, and unreadable ones, are skipped', async () => {
    await seed('local1', { system: null, workspace: null });
    await fs.mkdir(path.join(dir(), 'broken'), { recursive: true });
    await fs.writeFile(path.join(dir(), 'broken', 'project.json'), '{not json');
    await fs.mkdir(path.join(dir(), 'empty'), { recursive: true });

    assert.deepEqual(await run({ root, log: () => {} }), { applied: false });
    assert.equal((await read('local1')).system, null);
  });

  // PINS: a pair that COLLIDES once normalised is REPORTED and NOT merged. They
  // were already sharing a transcript directory; this only makes it visible,
  // and picking which to re-register is the operator's call.
  test('a pair that collides after normalising is named, not merged', async () => {
    await seed('one', { system: 'box', systemPath: '/srv/app' });
    await seed('two', { system: 'box', systemPath: '/srv/app/' });

    const logs = [];
    const r = await run({ root, log: (l) => logs.push(l) });
    assert.equal(r.summary.sharing, 1);
    assert.equal((await read('one')).systemPath, '/srv/app');
    assert.equal((await read('two')).systemPath, '/srv/app', 'both are normalised');
    assert.ok(logs.some(l => l.includes('one') && l.includes('two') && l.includes('transcript directory')),
      logs.join(' | '));
  });

  // PINS: the collision report uses encodeCwd, so `_` vs `.` counts — the same
  // collapse the guard refuses on, and the reason a byte comparison is not
  // enough.
  test('paths that merely encode alike are reported as sharing', async () => {
    await seed('one', { system: 'box', systemPath: '/srv/a_b' });
    await seed('two', { system: 'box', systemPath: '/srv/a.b' });
    const logs = [];
    assert.equal((await run({ root, log: (l) => logs.push(l) })).summary.sharing, 1);
  });

  // PINS THE CASE THE WIDENING EXISTS FOR, and it is the one an upgrading user
  // ALREADY has: the transcript directory is keyed on the working directory and
  // nothing else, so `/srv/app` on two different systems is one directory from
  // the first spawn after the upgrade. Keying the detector by system put these
  // in separate buckets and never named them — leaving the migration silent
  // about active sharing while making only FUTURE registrations detectable.
  test('the same path on two DIFFERENT systems is reported, naming both sides', async () => {
    await seed('one', { system: 'boxA', systemPath: '/srv/app' });
    await seed('two', { system: 'boxB', systemPath: '/srv/app' });
    const logs = [];
    const r = await run({ root, log: (l) => logs.push(l) });
    assert.equal(r.applied, true);
    assert.equal(r.summary.sharing, 1);
    const line = logs.find(l => l.includes('transcript directory'));
    assert.ok(line, logs.join(' | '));
    // NAMING BOTH SIDES is the point: "two projects collide" is unactionable,
    // and which system each is on is what tells the operator where to look.
    assert.match(line, /one \(on 'boxA'\)/);
    assert.match(line, /two \(on 'boxB'\)/);
  });

  // PINS: two TARGETS of one system at one path are reported too — the case the
  // README calls out by name. Same directory, same reasoning.
  test('two targets of one system at one path are reported', async () => {
    await seed('one', { system: 'box', remoteId: 'a', systemPath: '/srv/app' });
    await seed('two', { system: 'box', remoteId: 'b', systemPath: '/srv/app' });
    assert.equal((await run({ root, log: () => {} })).summary.sharing, 1);
  });

  // PINS ITEM 1 — THE BOOT-LOOP GUARD, the same shape 0033 pins: a record that
  // cannot be written is NAMED and the sweep continues. A throw here does not
  // fail one project, it stops cc from starting at all (runMigrations has no
  // try/catch and server.ts awaits it unguarded).
  test('a record that cannot be rewritten is reported, not thrown', async () => {
    await seed('blocked', { system: 'box', systemPath: '/srv/blocked/' });
    await seed('fine', { system: 'box', systemPath: '/srv/fine/' });
    await fs.chmod(path.join(dir(), 'blocked'), 0o500);
    const logs = [];
    try {
      const r = await run({ root, log: (l) => logs.push(l) });
      assert.equal(r.applied, true, 'the writable record was still normalised');
      assert.equal((await read('fine')).systemPath, '/srv/fine');
      assert.equal((await read('blocked')).systemPath, '/srv/blocked/', 'the blocked row kept its spelling');
      assert.ok(logs.some(l => l.includes('could not normalise') && l.includes('blocked')), logs.join(' | '));
    } finally {
      await fs.chmod(path.join(dir(), 'blocked'), 0o700);
    }
  });

  // PINS IDEMPOTENCE: a second run over normalised records applies nothing.
  test('a second run is a no-op', async () => {
    await seed('a', { system: 'box', systemPath: '/srv/app/' });
    assert.equal((await run({ root, log: () => {} })).applied, true);
    assert.equal((await run({ root, log: () => {} })).applied, false);
  });

  test('the module names itself for the log line', () => {
    assert.equal(name, '0035-normalize-system-paths');
  });
});
