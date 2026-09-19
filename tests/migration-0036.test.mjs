// 0036 clears the placement of pending-temp-cleanup entries written while the
// manifest persisted a bare `cwd`. The sweep now needs `{system, remoteId, cwd}`
// to name a subagent directory — `/root/app3` is one cwd on every box that has
// it — and a placement cannot be invented, because guessing one could delete a
// DIFFERENT remote's subagent directory.
//
// The loss is bounded and named: the sweep's existing placeless branch archives
// and unmarks but removes no directory, so at most one orphaned subagent dir per
// temp session in flight across the upgrade.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './helpers.mjs';
import { run, name } from '../migrations/0036-temp-cleanup-manifest-place.mjs';

describe('migration 0036: pending-temp-cleanup manifest placement', () => {
  let root;
  beforeEach(async () => { root = await mkdtemp('cc-m36-'); });
  afterEach(async () => { await rmrf(root); });

  const file = () => path.join(root, '.code-conductor', 'pending-temp-cleanup.json');
  const seed = async (payload) => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(payload));
  };
  const read = async () => JSON.parse(await fs.readFile(file(), 'utf8'));

  // PINS THE REWRITE: an old `{cwd, sessionId}` entry comes out carrying an
  // explicit `place: null` and no `cwd`, which is the shape the sweep's
  // bookkeeping-only branch reads.
  test('rewrites a bare-cwd entry to place: null and drops the cwd', async () => {
    await seed({
      writtenAt: '2026-01-01T00:00:00.000Z',
      entries: [{ cwd: '/root/app3', sessionId: 'aaaa1111-2222-4333-8444-555555555555' }],
    });

    const r = await run({ root, log: () => {} });
    assert.equal(r.applied, true);
    assert.equal(r.summary.cleared, 1);

    const after = await read();
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].place, null);
    assert.equal('cwd' in after.entries[0], false, 'the un-usable coordinate is removed, not left to mislead');
  });

  // PINS THAT NOTHING IS DESTROYED: the sessionId — the only field the sweep's
  // archive + unmark needs — survives verbatim, as does everything else on the
  // entry and the envelope around it.
  test('keeps the sessionId, the other fields and the envelope', async () => {
    await seed({
      writtenAt: '2026-01-01T00:00:00.000Z',
      entries: [{ cwd: '/root/app3', sessionId: 'aaaa1111-2222-4333-8444-555555555555', note: 'kept' }],
    });

    await run({ root, log: () => {} });
    const after = await read();
    assert.equal(after.writtenAt, '2026-01-01T00:00:00.000Z');
    assert.equal(after.entries[0].sessionId, 'aaaa1111-2222-4333-8444-555555555555');
    assert.equal(after.entries[0].note, 'kept');
  });

  // PINS IDEMPOTENCE, in the form that matters: the second run must not merely
  // produce the same file, it must report `applied:false` — a migration that
  // re-applies every boot is a migration whose self-check does not work.
  test('a second run is a no-op', async () => {
    await seed({ entries: [{ cwd: '/root/app3', sessionId: 'aaaa1111-2222-4333-8444-555555555555' }] });
    assert.equal((await run({ root, log: () => {} })).applied, true);
    const once = await read();

    const second = await run({ root, log: () => {} });
    assert.equal(second.applied, false);
    assert.deepEqual(await read(), once);
  });

  // An entry the CURRENT writer produced is already correct and must be left
  // exactly as it is — clearing it would strand a subagent directory the sweep
  // could have removed.
  test('an entry that already carries a placement is untouched', async () => {
    const place = { system: 'box', remoteId: 'r1', cwd: '/root/app3' };
    await seed({ entries: [{ place, sessionId: 'bbbb1111-2222-4333-8444-555555555555' }] });

    assert.equal((await run({ root, log: () => {} })).applied, false);
    assert.deepEqual((await read()).entries[0].place, place);
  });

  // A MIXED manifest: only the stale entries are cleared, and the good one
  // keeps its directory. A migration that cleared the batch would lose
  // cleanups it had no reason to.
  test('a mixed manifest clears only the stale entries', async () => {
    const place = { system: 'box', remoteId: null, cwd: '/root/app4' };
    await seed({
      entries: [
        { cwd: '/root/app3', sessionId: 'aaaa1111-2222-4333-8444-555555555555' },
        { place, sessionId: 'bbbb1111-2222-4333-8444-555555555555' },
      ],
    });

    const r = await run({ root, log: () => {} });
    assert.equal(r.summary.cleared, 1);
    const after = await read();
    assert.equal(after.entries[0].place, null);
    assert.deepEqual(after.entries[1].place, place);
  });

  // No manifest is the steady state on nearly every install — it is transient,
  // written on drain and unlinked on boot.
  test('no manifest is a clean no-op', async () => {
    assert.equal((await run({ root, log: () => {} })).applied, false);
  });

  // A torn manifest is the SWEEP's problem — it already parses defensively and
  // removes what it cannot read. This migration must not throw on it, because a
  // throwing migration aborts the boot.
  test('an unparseable or shapeless manifest does not abort the boot', async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), '{"entries": [');
    assert.equal((await run({ root, log: () => {} })).applied, false);

    await seed({ entries: 'not an array' });
    assert.equal((await run({ root, log: () => {} })).applied, false);
  });

  test('the migration declares its name', () => {
    assert.equal(name, '0036-temp-cleanup-manifest-place');
  });
});
