// WHAT `GET /api/fs/dirs` PROMISES (src/dirListing.ts).
//
// It lists the subdirectories of one absolute path on one system, through the
// System seam, for the path autocomplete. Two things are structural: a
// listing's COST is bounded (one readDir plus at most DIR_LIST_MAX_LINK_STATS
// stats, whatever the directory holds), and a refusal is a VALUE with the
// System layer's own code — never a guess at a new one.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { posixPlatform } from '../src/platform/posix.ts';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, wedgeLaunch } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { SystemError } from '../src/systems/protocol.ts';
import {
  listDirectories, selectDirs,
  DIR_LIST_MAX_ENTRIES, DIR_LIST_MAX_LINK_STATS, DIR_LIST_LINK_STAT_BATCH,
} from '../src/dirListing.ts';

const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');

const dir = name => ({ name, kind: 'dir', size: 0, mode: 0o40755, mtimeMs: 0 });
const link = name => ({ name, kind: 'symlink', size: 0, mode: 0o120777, mtimeMs: 0 });
const file = name => ({ name, kind: 'file', size: 0, mode: 0o100644, mtimeMs: 0 });

// A System stand-in with call counting: only the two methods the module uses.
function fakeSystem({ dirents = [], statImpl, readDirImpl } = {}) {
  const calls = { readDir: 0, stat: [], inFlight: 0, peak: 0 };
  return {
    calls,
    readDir: async (p) => { calls.readDir++; return readDirImpl ? readDirImpl(p) : dirents; },
    stat: async (p) => {
      calls.stat.push(p);
      calls.inFlight++; calls.peak = Math.max(calls.peak, calls.inFlight);
      try {
        await new Promise(r => setImmediate(r));
        return statImpl ? await statImpl(p) : { kind: 'dir', size: 0, mode: 0o40755, mtimeMs: 0 };
      } finally { calls.inFlight--; }
    },
  };
}

const unhandled = [];
const onUnhandled = e => unhandled.push(e);
before(() => process.on('unhandledRejection', onUnhandled));
after(() => process.off('unhandledRejection', onUnhandled));

describe('selectDirs: selection, cap and the link budget', () => {
  test('directories only, sorted by code unit, dot-directories kept', async () => {
    const sys = fakeSystem();
    const out = await selectDirs(sys, '/x', [dir('b'), file('a.txt'), dir('B'), dir('.git'), dir('a')]);
    assert.deepEqual(out.entries, ['.git', 'B', 'a', 'b']);
    assert.deepEqual(out.links, []);
    assert.equal(out.truncated, false);
    assert.equal(sys.calls.stat.length, 0, 'real directories cost no stat');
  });

  test('exactly the cap is not truncated', async () => {
    const dirents = Array.from({ length: DIR_LIST_MAX_ENTRIES }, (_, i) => dir(`d${String(i).padStart(5, '0')}`));
    const out = await selectDirs(fakeSystem(), '/x', dirents);
    assert.equal(out.entries.length, DIR_LIST_MAX_ENTRIES);
    assert.equal(out.truncated, false);
  });

  test('one over the cap is truncated to the first names', async () => {
    const dirents = Array.from({ length: DIR_LIST_MAX_ENTRIES + 1 }, (_, i) => dir(`d${String(i).padStart(5, '0')}`));
    const out = await selectDirs(fakeSystem(), '/x', dirents);
    assert.equal(out.entries.length, DIR_LIST_MAX_ENTRIES);
    assert.equal(out.truncated, true);
    assert.equal(out.entries.at(-1), `d${String(DIR_LIST_MAX_ENTRIES - 1).padStart(5, '0')}`);
  });

  test('a symlink resolves to a directory, a file, or nothing', async () => {
    const sys = fakeSystem({
      statImpl: async p => (p.endsWith('/todir') ? { kind: 'dir' } : p.endsWith('/tofile') ? { kind: 'file' } : null),
    });
    const out = await selectDirs(sys, '/x', [link('todir'), link('tofile'), link('broken')]);
    assert.deepEqual(out.entries, ['todir']);
    assert.deepEqual(out.links, [], 'a link that was answered is not left marked');
  });

  test('a per-entry stat error drops only that link', async () => {
    const sys = fakeSystem({
      statImpl: async p => {
        if (p.endsWith('/denied')) throw new SystemError('EACCES', 'denied');
        return { kind: 'dir' };
      },
    });
    const out = await selectDirs(sys, '/x', [link('denied'), link('ok'), dir('real')]);
    assert.deepEqual(out.entries, ['ok', 'real']);
    assert.deepEqual(out.links, []);
  });

  test('a transport failure on an in-budget link fails the listing', async () => {
    const sys = fakeSystem({ statImpl: async () => { throw new SystemError('ETRANSPORT', 'pipe closed'); } });
    await assert.rejects(() => selectDirs(sys, '/x', [link('a')]), { code: 'ETRANSPORT' });
  });

  describe('over the budget', () => {
    const many = Array.from({ length: DIR_LIST_MAX_LINK_STATS + 10 }, (_, i) => link(`l${String(i).padStart(3, '0')}`));
    const names = many.map(d => d.name);

    test('stat is called exactly the budget, over-budget links come back marked', async () => {
      const sys = fakeSystem();
      const out = await selectDirs(sys, '/x', [...many, dir('real1'), dir('real2')]);
      assert.equal(sys.calls.stat.length, DIR_LIST_MAX_LINK_STATS);
      assert.deepEqual(out.links, names.slice(DIR_LIST_MAX_LINK_STATS));
      assert.equal(out.links.length, 10);
      assert.deepEqual(out.entries, ['real1', 'real2', ...names.slice(0, DIR_LIST_MAX_LINK_STATS)].sort());
    });

    test('the resolved links are the first by name', async () => {
      const sys = fakeSystem();
      await selectDirs(sys, '/x', [...many].reverse());
      assert.deepEqual(sys.calls.stat.slice().sort(),
        names.slice(0, DIR_LIST_MAX_LINK_STATS).map(n => `/x/${n}`));
    });

    test('stats in flight never exceed one batch', async () => {
      const sys = fakeSystem();
      await selectDirs(sys, '/x', many);
      assert.ok(sys.calls.peak <= DIR_LIST_LINK_STAT_BATCH, `peak ${sys.calls.peak}`);
      assert.ok(sys.calls.peak > 1, 'and they do run concurrently');
    });
  });

  test('a stat that never settles leaves every link marked, within the sub-deadline', async () => {
    const sys = fakeSystem({ statImpl: () => new Promise(() => {}) });
    const out = await selectDirs(sys, '/x', [link('a'), link('b'), dir('real')], { linkDeadlineMs: 20 });
    assert.deepEqual(out.entries, ['real']);
    assert.deepEqual(out.links, ['a', 'b']);
    assert.equal(sys.calls.stat.length, 2, 'no further batch starts once the sub-deadline fires');
  });

  test('no batch starts after the sub-deadline: stat calls stop at the batch boundary', async () => {
    const many = Array.from({ length: DIR_LIST_LINK_STAT_BATCH * 3 }, (_, i) => link(`l${String(i).padStart(3, '0')}`));
    const sys = fakeSystem({ statImpl: () => new Promise(() => {}) });
    const out = await selectDirs(sys, '/x', many, { linkDeadlineMs: 20 });
    assert.equal(sys.calls.stat.length, DIR_LIST_LINK_STAT_BATCH);
    assert.equal(out.links.length, many.length, 'every link, started or not, is returned marked');
    assert.deepEqual(out.entries, []);
  });

  test('a late rejection after the sub-deadline is not an unhandled rejection', async () => {
    let reject;
    const sys = fakeSystem({ statImpl: () => new Promise((_, rej) => { reject = rej; }) });
    await selectDirs(sys, '/x', [link('a')], { linkDeadlineMs: 10 });
    reject(new SystemError('ETRANSPORT', 'late'));
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  });
});

describe('listDirectories on a fake System-free path: argument checks', () => {
  for (const [title, q, code] of [
    ['relative', { path: 'rel/dir' }, 'INVALID_PATH'],
    ['empty', { path: '' }, 'INVALID_PATH'],
    ['absent', {}, 'INVALID_PATH'],
    ['repeated parameter', { path: ['/a', '/b'] }, 'INVALID_PATH'],
    ['remoteId on local', { path: '/tmp', remoteId: 'r' }, 'INVALID_REMOTE_ID'],
    ['remoteId on explicit local', { path: '/tmp', system: 'local', remoteId: 'r' }, 'INVALID_REMOTE_ID'],
    ['remoteId as array', { path: '/tmp', system: 'x', remoteId: ['a'] }, 'INVALID_REMOTE_ID'],
  ]) {
    test(`${title} → ${code}`, async () => {
      const r = await listDirectories(q);
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
      assert.ok(r.reason, 'a reason accompanies the code');
    });
  }
});

describe('listDirectories and the route, against real systems', () => {
  let ctx, home, tree;
  before(async () => { ctx = await bootServer({}); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    tree = await fs.realpath(await mkdtemp('cc-dirs-'));
  });
  afterEach(async () => {
    disposeSystemHandles();
    await rmrf(home);
    await rmrf(tree);
  });

  const get = (q) => api(ctx.baseUrl, 'GET', '/api/fs/dirs?' + new URLSearchParams(q));

  test('local: directories, a link to a directory, nothing for files or dead links', async () => {
    await fs.mkdir(path.join(tree, 'beta'));
    await fs.mkdir(path.join(tree, '.hidden'));
    await fs.mkdir(path.join(tree, 'alpha'));
    await fs.writeFile(path.join(tree, 'a-file'), '');
    await fs.symlink(path.join(tree, 'alpha'), path.join(tree, 'to-dir'));
    await fs.symlink(path.join(tree, 'a-file'), path.join(tree, 'to-file'));
    await fs.symlink(path.join(tree, 'missing'), path.join(tree, 'broken'));
    const r = await get({ path: tree });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      ok: true, system: 'local', remoteId: null, path: tree,
      entries: ['.hidden', 'alpha', 'beta', 'to-dir'], links: [], truncated: false, max: DIR_LIST_MAX_ENTRIES,
    });
  });

  test('a relative path, a file and a missing path are named refusals', async () => {
    await fs.writeFile(path.join(tree, 'f'), '');
    assert.equal((await get({ path: 'rel' })).body.code, 'INVALID_PATH');
    const onFile = await get({ path: path.join(tree, 'f') });
    assert.equal(onFile.status, 200);
    assert.equal(onFile.body.code, 'ENOTDIR');
    assert.equal((await get({ path: path.join(tree, 'nope') })).body.code, 'ENOENT');
  });

  test('a repeated path parameter is refused, not listed', async () => {
    const r = await api(ctx.baseUrl, 'GET', `/api/fs/dirs?path=${encodeURIComponent(tree)}&path=/tmp`);
    assert.equal(r.body.code, 'INVALID_PATH');
  });

  describe('remote dispatch', () => {
    test('remoteId lists the named target, and an unknown one is refused by name', async () => {
      await fs.mkdir(path.join(tree, 'sub1'));
      await fs.mkdir(path.join(tree, 'sub2'));
      const { id } = await bindRemoteSystem({ flags: ['--remote', `a=${tree}`] });
      const ok = await get({ system: id, remoteId: 'a', path: tree });
      assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.entries, ['sub1', 'sub2']);
      assert.equal(ok.body.system, id);
      assert.equal(ok.body.remoteId, 'a');
      const bad = await get({ system: id, remoteId: 'zz', path: tree });
      assert.equal(bad.body.code, 'REMOTE_NOT_FOUND', JSON.stringify(bad.body));
    });

    test('a provider with no remotes refuses a remoteId', async () => {
      const { id, root } = await bindRemoteSystem();
      const r = await get({ system: id, remoteId: 'a', path: root });
      assert.equal(r.body.code, 'SYSTEM_NO_REMOTES', JSON.stringify(r.body));
    });

    test('an unregistered system, and a row with no provider', async () => {
      assert.equal((await get({ system: 'nobody', path: tree })).body.code, 'SYSTEM_NOT_REGISTERED');
      const { id } = await bindRemoteSystem();
      await updateSystem(id, { launch: null });
      assert.equal((await get({ system: id, path: tree })).body.code, 'SYSTEM_NO_PROVIDER');
    });

    test('a system that stops answering is SYSTEM_UNREACHABLE', async () => {
      const gate = path.join(home, 'gate');
      await addSystem({ id: 'gatedbox', label: 'Gated box', launch: ['node', GATED, '--gate', gate] });
      await fs.writeFile(gate, '');
      disposeSystemHandles();
      assert.equal((await get({ system: 'gatedbox', path: tree })).body.code, 'SYSTEM_UNREACHABLE');
    });

    test('a wedged provider is LIST_TIMEOUT at the endpoint deadline, not the op fence', async () => {
      const { id, root } = await bindRemoteSystem();
      await updateSystem(id, { launch: wedgeLaunch() });
      const t0 = Date.now();
      const r = await listDirectories({ system: id, path: root }, { deadlineMs: 50 });
      assert.equal(r.code, 'LIST_TIMEOUT', JSON.stringify(r));
      assert.match(r.reason, /50 ms/);
      assert.ok(Date.now() - t0 < 5000);
    });
  });
});

describe('capability off', () => {
  let ctx;
  before(async () => {
    ctx = await bootServer({
      platform: { ...posixPlatform, capabilities: { ...posixPlatform.capabilities, remoteSystems: false } },
    });
  });
  after(async () => { await ctx.close(); });

  test('a named system is SYSTEMS_UNAVAILABLE, local still lists', async () => {
    const off = await api(ctx.baseUrl, 'GET', '/api/fs/dirs?' + new URLSearchParams({ system: 'x', path: '/tmp' }));
    assert.equal(off.body.ok, false);
    assert.equal(off.body.code, 'SYSTEMS_UNAVAILABLE');
    const tree = await fs.realpath(await mkdtemp('cc-dirs-'));
    try {
      await fs.mkdir(path.join(tree, 'sub'));
      const local = await api(ctx.baseUrl, 'GET', '/api/fs/dirs?' + new URLSearchParams({ path: tree }));
      assert.deepEqual(local.body.entries, ['sub'], JSON.stringify(local.body));
    } finally { await rmrf(tree); }
  });
});

describe('listDirectories with a fake System', () => {
  const via = sys => ({ resolveSystem: async () => sys });

  test('EUNKNOWN passes through with its raw stderr in the reason', async () => {
    const sys = fakeSystem({
      readDirImpl: () => { throw new SystemError('EUNKNOWN', "readDir '/x': find: unrecognized: -printf"); },
    });
    const r = await listDirectories({ system: 'box', path: '/x' }, via(sys));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EUNKNOWN');
    assert.match(r.reason, /-printf/);
  });

  test('ENOTDIR passes through', async () => {
    const sys = fakeSystem({ readDirImpl: () => { throw new SystemError('ENOTDIR', 'not a directory'); } });
    assert.equal((await listDirectories({ system: 'box', path: '/x' }, via(sys))).code, 'ENOTDIR');
  });

  test('a throw that is not a System or errno error is rethrown, not mapped', async () => {
    const sys = fakeSystem({ readDirImpl: () => { throw new TypeError('bug'); } });
    await assert.rejects(() => listDirectories({ system: 'box', path: '/x' }, via(sys)), TypeError);
  });

  test('an ETRANSPORT on an in-budget link refuses the listing', async () => {
    const sys = fakeSystem({
      dirents: [link('a')],
      statImpl: async () => { throw new SystemError('ETRANSPORT', 'pipe closed'); },
    });
    const r = await listDirectories({ system: 'box', path: '/x' }, via(sys));
    assert.equal(r.code, 'ETRANSPORT');
  });

  test('over-budget links still give ok:true with the extras named', async () => {
    const dirents = Array.from({ length: DIR_LIST_MAX_LINK_STATS + 10 }, (_, i) => link(`l${String(i).padStart(3, '0')}`));
    const sys = fakeSystem({ dirents });
    const r = await listDirectories({ system: 'box', path: '/x' }, via(sys));
    assert.equal(r.ok, true);
    assert.equal(sys.calls.stat.length, DIR_LIST_MAX_LINK_STATS);
    assert.equal(r.links.length, 10);
  });

  test('a readDir that never resolves is LIST_TIMEOUT, with no unhandled rejection', async () => {
    const before = unhandled.length;
    const sys = fakeSystem({ readDirImpl: () => new Promise(() => {}) });
    const r = await listDirectories({ system: 'box', path: '/x' }, { ...via(sys), deadlineMs: 20 });
    assert.equal(r.code, 'LIST_TIMEOUT');
    await new Promise(res => setTimeout(res, 20));
    assert.equal(unhandled.length, before);
  });

  test('a stat that never settles never becomes LIST_TIMEOUT', async () => {
    const sys = fakeSystem({ dirents: [link('a'), dir('d')], statImpl: () => new Promise(() => {}) });
    // The link sub-deadline (20 ms) outlasts the endpoint deadline (50 ms) only
    // if the link phase were inside it: it is not, so the listing stays ok.
    const r = await listDirectories({ system: 'box', path: '/x' }, { ...via(sys), deadlineMs: 50, linkDeadlineMs: 20 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.links, ['a']);
  });
});
