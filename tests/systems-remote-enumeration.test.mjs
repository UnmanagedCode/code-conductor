// REMOTE ENUMERATION: which remoteIds a registered System's provider says it is
// configured for (docs/systems-protocol.md §2.2), as cc's one caller
// (`enumerateSystemRemotes`, src/systems/remoteEnumeration.ts) answers it.
//
// THREE STATES, NEVER COLLAPSED. `listed` carries the ids, possibly none;
// `not-enumerable` and `failed` carry a reason and never a list. A failure read
// as `[]` would tell a user their provider is configured for nothing; a
// not-enumerable System read as `[]` would say the same of a provider that was
// never asked.
//
// The wire-level capability gate is pinned in
// tests/systems-remote-listing-fallback.test.mjs; this file pins what the
// enumerator makes of each answer.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { referenceLaunch } from './remoteSystem.mjs';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { readRemoteList } from '../src/systems/protocol.ts';
import {
  LOCAL_NOT_ENUMERABLE, enumerateAllRemotes, enumerateSystemRemotes,
} from '../src/systems/remoteEnumeration.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'remoteListFixtureProvider.mjs');
const fixtureLaunch = (...flags) => ['node', FIXTURE, ...flags];

const scratch = async () => fs.realpath(await mkdtemp('cc-remote-'));

async function framesIn(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('remote enumeration', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS the happy path: a provider that advertises remoteListing is asked, and
  // its configured ids come back `listed`.
  test("a listing provider's configured ids come back listed", async () => {
    const root = await scratch();
    await addSystem({ id: 'lister', label: 'Lister', launch: referenceLaunch('--remote', `a=${root}`, '--remote', `b=${root}`) });
    const r = await enumerateSystemRemotes('lister');
    assert.equal(r.state, 'listed', JSON.stringify(r));
    assert.deepEqual([...r.remoteIds].sort(), ['a', 'b']);
    assert.equal(r.label, 'Lister');
  });

  // PINS NO MEMOISATION: each enumeration is a fresh round trip, so a
  // configuration that changed between two asks is seen by the second. Two
  // asks, two frames on the wire, two different answers.
  test('each enumeration asks afresh and sees a changed configuration', async () => {
    const dir = await mkdtemp('cc-list-');
    const list = path.join(dir, 'list.json');
    const log = path.join(dir, 'frames.jsonl');
    await fs.writeFile(list, '[{"remoteId":"x"}]');
    await addSystem({ id: 'shifty', label: 'Shifty', launch: fixtureLaunch('--advertise-listing', '--list-file', list, '--frame-log', log) });

    assert.deepEqual((await enumerateSystemRemotes('shifty')).remoteIds, ['x']);
    await fs.writeFile(list, '[{"remoteId":"y"},{"remoteId":"z"}]');
    assert.deepEqual((await enumerateSystemRemotes('shifty')).remoteIds, ['y', 'z']);
    assert.equal((await framesIn(log)).filter(f => f.type === 'listRemotes').length, 2);
  });

  // PINS error → failed, EUNSUPPORTED INCLUDED. Unlike `mirror()`, which reads
  // an advertiser's EUNSUPPORTED as "advertises nothing", a list has no safe
  // default: swallowing it would turn a provider that broke its own
  // advertisement into one configured for nothing.
  test('an advertiser answering EUNSUPPORTED is a failed enumeration', async () => {
    await addSystem({ id: 'liar', label: 'Liar', launch: fixtureLaunch('--advertise-listing', '--list-error', 'EUNSUPPORTED') });
    const r = await enumerateSystemRemotes('liar');
    assert.equal(r.state, 'failed', JSON.stringify(r));
    assert.equal(r.code, 'EUNSUPPORTED');
    assert.equal('remoteIds' in r, false);
  });

  // PINS error → failed with the PROVIDER'S reason: the user is told why.
  test("an error answer fails with the provider's reason", async () => {
    await addSystem({ id: 'broken', label: 'Broken', launch: fixtureLaunch('--advertise-listing', '--list-error', 'EUNKNOWN') });
    const r = await enumerateSystemRemotes('broken');
    assert.equal(r.state, 'failed', JSON.stringify(r));
    assert.equal(r.code, 'EUNKNOWN');
    assert.match(r.reason, /configuration unreadable/);
  });

  // PINS readRemoteList VALIDATION at the caller: an answer cc will not believe
  // is a FAILED enumeration naming readRemoteList's own reason — never a
  // partial list, never an empty one. And its complement: an empty list is a
  // true answer and comes back `listed`.
  test('readRemoteList refuses an invalid answer, and the enumeration fails with its reason', async (t) => {
    const cases = [
      ['the remotes field absent', 'ABSENT', {}],
      ['remotes null', 'null', { remotes: null }],
      ['an entry with no remoteId', '[{}]', { remotes: [{}] }],
      ['a remoteId that is not a valid remoteId', '[{"remoteId":"a b"}]', { remotes: [{ remoteId: 'a b' }] }],
      ['a remoteId listed twice', '[{"remoteId":"a"},{"remoteId":"a"}]', { remotes: [{ remoteId: 'a' }, { remoteId: 'a' }] }],
    ];
    let n = 0;
    for (const [title, raw, frame] of cases) {
      await t.test(title, async () => {
        const id = `bad-${n++}`;
        const list = path.join(await mkdtemp('cc-list-'), 'list.json');
        await fs.writeFile(list, raw);
        await addSystem({ id, label: id, launch: fixtureLaunch('--advertise-listing', '--list-file', list) });
        const r = await enumerateSystemRemotes(id);
        assert.equal(r.state, 'failed', JSON.stringify(r));
        assert.equal(r.code, 'REMOTE_LIST_INVALID');
        assert.equal('remoteIds' in r, false);
        const refused = readRemoteList(frame);
        assert.equal(refused.ok, false, 'the fixture case really is one readRemoteList refuses');
        assert.ok(r.reason.includes(refused.reason), `${r.reason} names ${refused.reason}`);
      });
    }
    await t.test('an empty list is listed, not failed', async () => {
      const list = path.join(await mkdtemp('cc-list-'), 'list.json');
      await fs.writeFile(list, '[]');
      await addSystem({ id: 'empty', label: 'Empty', launch: fixtureLaunch('--advertise-listing', '--list-file', list) });
      assert.deepEqual(await enumerateSystemRemotes('empty'),
        { system: 'empty', label: 'Empty', state: 'listed', remoteIds: [] });
    });
  });

  // PINS PER-SYSTEM ISOLATION AND NEVER-REJECT: one System failing — by its
  // provider's answer, or by having no provider at all — costs only its own
  // entry. Every registered System is reported, in registry order, `local`
  // first, each with its own state.
  test('one failing System does not hide the others', async () => {
    const root = await scratch();
    await addSystem({ id: 'lister', label: 'Lister', launch: referenceLaunch('--remote', `a=${root}`) });
    await addSystem({ id: 'plain', label: 'Plain', launch: referenceLaunch() });
    await addSystem({ id: 'broken', label: 'Broken', launch: fixtureLaunch('--advertise-listing', '--list-error', 'EUNKNOWN') });
    await addSystem({ id: 'bare', label: 'Bare' });

    const all = await enumerateAllRemotes();
    assert.deepEqual(all.map(e => [e.system, e.state, e.code ?? null, e.remoteIds ?? null]), [
      ['local', 'not-enumerable', null, null],
      ['lister', 'listed', null, ['a']],
      ['plain', 'not-enumerable', null, null],
      ['broken', 'failed', 'EUNKNOWN', null],
      ['bare', 'failed', 'SYSTEM_NO_PROVIDER', null],
    ]);
  });

  // PINS THE LOCAL SHORT-CIRCUIT, decided by id before any handle is touched.
  // The exact reason is the point: it is what tells the short-circuit apart
  // from the not-a-provider fallback in plain `npm test`, and under the gate's
  // row 1 — where `local` is a ProviderSystem that advertises remoteListing —
  // anything but the short-circuit would come back `listed`.
  test('local is never enumerated, decided by id', async () => {
    assert.deepEqual(await enumerateSystemRemotes('local'),
      { system: 'local', label: 'This machine', state: 'not-enumerable', reason: LOCAL_NOT_ENUMERABLE });
  });

  // PINS failure ≠ empty for the registry's own refusal: an id nobody
  // registered is a failed enumeration with the registry's code.
  test('an unregistered id is a failed enumeration', async () => {
    const r = await enumerateSystemRemotes('nosuch');
    assert.equal(r.state, 'failed', JSON.stringify(r));
    assert.equal(r.code, 'SYSTEM_NOT_REGISTERED');
    assert.equal(r.label, 'nosuch', 'an unregistered id has no label of its own');
  });
});

// PINS THE BACKSTOP: `listRemotes` goes through the same per-operation ceiling
// as every other request, so a provider that advertises the capability and
// then never answers rejects ETIMEDOUT rather than wedging the caller — and the
// connection survives it, because a mute answer is not a dead transport.
test('listRemotes is bounded by the backstop', async () => {
  const sys = new ProviderSystem({
    id: 'mute', launch: { argv: fixtureLaunch('--advertise-listing', '--mute-listing') }, defaultOpTimeoutMs: 200,
  });
  try {
    await assert.rejects(sys.listRemotes(), (e) => {
      assert.equal(e.code, 'ETIMEDOUT');
      assert.match(e.message, /200ms/);
      return true;
    });
    const r = await sys.exec({ argv: ['true'] }, { cwd: '/', stdin: 'ignore' });
    assert.equal(r.code, 0, JSON.stringify(r));
  } finally {
    sys.dispose();
  }
});

describe('GET /api/systems/:id/remotes', () => {
  let ctx, home;
  before(async () => { ctx = await bootServer(); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS THE ROUTE SHAPE AND THE ONE CALLER: every per-System outcome is a 200
  // whose body is exactly what the enumerator answers — a failure is a state in
  // the body, never an HTTP error that a client could mistake for "no list".
  test("answers the enumerator's state, 200 for every outcome", async () => {
    const root = await scratch();
    await addSystem({ id: 'lister', label: 'Lister', launch: referenceLaunch('--remote', `a=${root}`) });
    await addSystem({ id: 'plain', label: 'Plain', launch: referenceLaunch() });
    await addSystem({ id: 'broken', label: 'Broken', launch: fixtureLaunch('--advertise-listing', '--list-error', 'EUNKNOWN') });

    for (const [id, state] of [['lister', 'listed'], ['plain', 'not-enumerable'], ['broken', 'failed'], ['nosuch', 'failed']]) {
      const r = await api(ctx.baseUrl, 'GET', `/api/systems/${id}/remotes`);
      assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.state, state, `${id}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, await enumerateSystemRemotes(id));
    }
  });
});
