// THE system_transfer MCP TOOL: endpoint validation, (system, remoteId)
// addressing shared with system_bash, the cc-store guard, and the wire surface.
// The engine's own invariants are pinned in tests/systems-transfer.test.mjs;
// this file pins what the handler adds around it.
//
// Every refusal here is a RETURNED {ok:false, code, …}, never a throw: the
// handler converts systemById's named refusals rather than letting them reach
// the caller as tool errors.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { liveSystemProto } from './systemHandle.mjs';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, localSystem } from '../src/systems/registry.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { systemTransfer } from '../src/mcp/handlers.ts';

const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const BYTES = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x0a, 0x00, 0x80]);

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

describe('system_transfer', () => {
  let ctx, baseUrl, home, root;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    root = await fs.realpath(await mkdtemp('cc-xfer-'));
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  async function seed(name, data = BYTES) {
    const p = path.join(root, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return p;
  }

  test('local → local copies and returns {from, to, bytes, mode, moved} with no `ok`', async () => {
    const src = await seed('src');
    await fs.chmod(src, 0o750);
    const dst = path.join(root, 'dst');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: 'local', path: dst } });
    assert.deepEqual(r, {
      from: { system: 'local', remoteId: null, path: src },
      to: { system: 'local', remoteId: null, path: dst },
      bytes: BYTES.length,
      mode: '0750',
      moved: false,
    });
    assert.equal(sha(await fs.readFile(dst)), sha(BYTES));
  });

  test('local → refbox and refbox → local are hash-identical', async () => {
    const remote = await bindRemoteSystem();
    const src = await seed('src');
    const there = path.join(remote.root, 'there');
    const r1 = await systemTransfer({ from: { system: 'local', path: src }, to: { system: remote.id, path: there } });
    assert.equal(r1.ok, undefined, JSON.stringify(r1));
    assert.equal(r1.to.system, remote.id);
    const back = path.join(root, 'back');
    const r2 = await systemTransfer({ from: { system: remote.id, path: there }, to: { system: 'local', path: back }, move: true });
    assert.equal(r2.ok, undefined, JSON.stringify(r2));
    assert.equal(r2.moved, true);
    assert.equal(sha(await fs.readFile(back)), sha(BYTES));
    assert.equal(await exists(there), false);
  });

  // The `--remote` fence refuses a read or write outside the target's own root,
  // so a side resolved against the OTHER remote fails EACCES instead of passing.
  test('remote a → remote b on one system routes each side to its own target', async () => {
    const rootA = await fs.realpath(await mkdtemp('cc-xfer-a-'));
    const rootB = await fs.realpath(await mkdtemp('cc-xfer-b-'));
    await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`, '--remote', `b=${rootB}`] });
    const src = path.join(rootA, 'f');
    await fs.writeFile(src, BYTES);
    const dst = path.join(rootB, 'g');
    const r = await systemTransfer({
      from: { system: 'boxes', remoteId: 'a', path: src },
      to: { system: 'boxes', remoteId: 'b', path: dst },
    });
    assert.equal(r.ok, undefined, JSON.stringify(r));
    assert.deepEqual(r.from, { system: 'boxes', remoteId: 'a', path: src });
    assert.deepEqual(r.to, { system: 'boxes', remoteId: 'b', path: dst });
    assert.equal(sha(await fs.readFile(dst)), sha(BYTES));
  });

  test('an empty remoteId means the default target', async () => {
    const remote = await bindRemoteSystem();
    const src = await seed('src');
    const dst = path.join(remote.root, 'out');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: remote.id, remoteId: '', path: dst } });
    assert.equal(r.ok, undefined, JSON.stringify(r));
    assert.equal(r.to.remoteId, null);
    assert.equal(sha(await fs.readFile(dst)), sha(BYTES));
  });

  test("remoteId:'' on local means the default target, not SYSTEM_NO_REMOTES", async () => {
    const src = await seed('src');
    const dst = path.join(root, 'out');
    const r = await systemTransfer({ from: { system: 'local', remoteId: '', path: src }, to: { system: 'local', remoteId: '', path: dst } });
    assert.equal(r.ok, undefined, JSON.stringify(r));
    assert.equal(r.from.remoteId, null);
    assert.equal(r.to.remoteId, null);
    assert.equal(sha(await fs.readFile(dst)), sha(BYTES));
  });

  test('an unregistered system is a returned SYSTEM_NOT_REGISTERED naming the side', async () => {
    const src = await seed('src');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: 'nosuch', path: '/tmp/x' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SYSTEM_NOT_REGISTERED', JSON.stringify(r));
    assert.equal(r.side, 'to');
    assert.match(r.reason, /nosuch/);
  });

  test('a system without a provider command is SYSTEM_NO_PROVIDER', async () => {
    const remote = await bindRemoteSystem();
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });
    const r = await systemTransfer({ from: { system: remote.id, path: '/x' }, to: { system: 'local', path: path.join(root, 'out') } });
    assert.equal(r.code, 'SYSTEM_NO_PROVIDER', JSON.stringify(r));
    assert.equal(r.side, 'from');
  });

  test('an unknown remoteId is REMOTE_NOT_FOUND', async () => {
    const rootA = await fs.realpath(await mkdtemp('cc-xfer-a-'));
    await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`] });
    const src = await seed('src');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: 'boxes', remoteId: 'zzz', path: path.join(rootA, 'f') } });
    assert.equal(r.code, 'REMOTE_NOT_FOUND', JSON.stringify(r));
    assert.equal(r.side, 'to');
  });

  test('an unreachable system is SYSTEM_UNREACHABLE', async () => {
    const gate = path.join(home, 'gate');
    await addSystem({ id: 'gatedbox', label: 'Gated box', launch: ['node', GATED, '--gate', gate] });
    await fs.writeFile(gate, '');
    disposeSystemHandles();
    const src = await seed('src');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: 'gatedbox', path: '/tmp/x' } });
    assert.equal(r.code, 'SYSTEM_UNREACHABLE', JSON.stringify(r));
    assert.equal(r.side, 'to');
  });

  // `local` is pinned to remoteId null, so a remoteId there would be silently
  // ignored and the transfer would run on cc's host.
  test('a remoteId on local is SYSTEM_NO_REMOTES and nothing is read', async () => {
    const src = await seed('src');
    const dst = path.join(root, 'out');
    const proto = liveSystemProto(localSystem());
    const touched = [];
    const saved = {};
    for (const m of ['stat', 'lstat', 'readFileBytes', 'writeFileBytes']) {
      saved[m] = proto[m];
      proto[m] = function (...a) { touched.push(m); return saved[m].apply(this, a); };
    }
    let r;
    try {
      r = await systemTransfer({ from: { system: 'local', remoteId: 'box1', path: src }, to: { system: 'local', path: dst } });
    } finally {
      for (const m of Object.keys(saved)) proto[m] = saved[m];
    }
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SYSTEM_NO_REMOTES', JSON.stringify(r));
    assert.equal(r.side, 'from');
    assert.deepEqual(touched, [], 'no System member ran');
    assert.equal(await exists(dst), false);
  });

  // `from` names an UNREGISTERED system: had resolution run first, the answer
  // would be SYSTEM_NOT_REGISTERED on `from` instead.
  test('a relative path, a trailing slash or an unknown endpoint key is ENDPOINT_INVALID, before any system is resolved', async () => {
    const from = { system: 'nosuch', path: '/abs/src' };
    for (const [to, what] of [
      [{ system: 'local', path: 'rel/out' }, 'a relative path'],
      [{ system: 'local', path: '/abs/dir/' }, 'a trailing slash'],
      [{ system: 'local', path: '/' }, 'the root'],
      [{ system: 'local', path: '/abs/a\0b' }, 'a NUL'],
      [{ system: 'local', remote: 'x', path: '/abs/out' }, 'an unknown key'],
      [{ system: '', path: '/abs/out' }, 'an empty system'],
      [{ system: 'local', remoteId: 3, path: '/abs/out' }, 'a non-string remoteId'],
      [{ system: 'local' }, 'a missing path'],
      ['local:/abs/out', 'a non-object endpoint'],
    ]) {
      const r = await systemTransfer({ from, to });
      assert.equal(r.ok, false, what);
      assert.equal(r.code, 'ENDPOINT_INVALID', `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.side, 'to', what);
    }
  });

  // `to` names an UNREGISTERED system: had resolution run first, the answer
  // would be SYSTEM_NOT_REGISTERED on `to`; so would `from`'s own unregistered id.
  test('a malformed `from` is ENDPOINT_INVALID on side from, before any system is resolved', async () => {
    const to = { system: 'nosuch', path: '/abs/out' };
    for (const [from, what] of [
      [{ system: 'nosuch', path: 'rel/src' }, 'a relative path'],
      [{ system: 'nosuch', path: '/abs/dir/' }, 'a trailing slash'],
      [{ system: 'nosuch', path: '/abs/a\0b' }, 'a NUL'],
      [{ system: 'nosuch', remote: 'x', path: '/abs/src' }, 'an unknown key'],
    ]) {
      const r = await systemTransfer({ from, to });
      assert.equal(r.ok, false, what);
      assert.equal(r.code, 'ENDPOINT_INVALID', `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.side, 'from', what);
    }
  });

  test("a destination inside cc's store is PATH_IN_CC_STORE and nothing is written", async () => {
    const src = await seed('src');
    const dst = path.join(orchStoreRoot(), 'planted.json');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: 'local', path: dst }, overwrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PATH_IN_CC_STORE', JSON.stringify(r));
    assert.equal(r.side, 'to');
    assert.equal(await exists(dst), false);
  });

  test("a move out of cc's store is refused; a copy out of it is allowed", async () => {
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    const inStore = path.join(orchStoreRoot(), 'some.log');
    await fs.writeFile(inStore, BYTES);
    const out = path.join(root, 'copied.log');

    const moved = await systemTransfer({ from: { system: 'local', path: inStore }, to: { system: 'local', path: out }, move: true });
    assert.equal(moved.code, 'PATH_IN_CC_STORE', JSON.stringify(moved));
    assert.equal(moved.side, 'from');
    assert.equal(await exists(out), false);

    const copied = await systemTransfer({ from: { system: 'local', path: inStore }, to: { system: 'local', path: out } });
    assert.equal(copied.ok, undefined, JSON.stringify(copied));
    assert.equal(sha(await fs.readFile(out)), sha(BYTES));
    assert.equal(await exists(inStore), true);
  });

  test("a move into cc's store is PATH_IN_CC_STORE on side to, nothing is written and the source is kept", async () => {
    const src = await seed('src');
    const dst = path.join(orchStoreRoot(), 'moved-in');
    const r = await systemTransfer({ from: { system: 'local', path: src }, to: { system: 'local', path: dst }, move: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PATH_IN_CC_STORE', JSON.stringify(r));
    assert.equal(r.side, 'to');
    assert.equal(await exists(dst), false);
    assert.equal(sha(await fs.readFile(src)), sha(BYTES));
  });

  test('tools/call returns the result as compact JSON and a refusal without isError', async () => {
    const src = await seed('src');
    const dst = path.join(root, 'dst');
    const ok = await callTool(baseUrl, 'system_transfer', { from: { system: 'local', path: src }, to: { system: 'local', path: dst } });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.equal(ok.content.length, 1);
    const body = JSON.parse(ok.content[0].text);
    assert.equal(body.bytes, BYTES.length);
    assert.equal(body.moved, false);

    const refused = await callTool(baseUrl, 'system_transfer', { from: { system: 'local', path: src }, to: { system: 'local', path: dst } });
    assert.equal(refused.isError, undefined, JSON.stringify(refused));
    const rb = JSON.parse(refused.content[0].text);
    assert.equal(rb.ok, false);
    assert.equal(rb.code, 'DEST_EXISTS');
  });
});
