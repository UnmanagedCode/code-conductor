// The projects-root lock (src/rootLock.ts): one holder per root, judged by its
// socket alone — never by pid or age — plus generation supersession, the
// endpoint choice per host, and the restart handover's lock half.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireRootLock, probeHolder, parseRootLockRecord, RootLockHeldError, RootLockUnreadableError,
  ROOT_LOCK_DIRNAME, ROOT_LOCK_HANDOVER_ENV, ROOT_LOCK_HELD_EXIT,
} from '../src/rootLock.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { createWin32Platform } from '../src/platform/win32.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { LINK_PROBE_PREFIX } from '../src/storeLock.ts';

const HOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rootLockHolder.mjs');
const QUIET = { warn() {} };

async function freshRoot(t) {
  const root = await mkdtemp('root-lock-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const storeOf = (root) => path.join(root, '.code-conductor');
const lockDirOf = (root) => path.join(storeOf(root), ROOT_LOCK_DIRNAME);
const genFiles = (root) => fs.readdirSync(lockDirOf(root)).filter((n) => /^\d+\.json$/.test(n)).sort();
const readRec = (root, gen) => parseRootLockRecord(fs.readFileSync(path.join(lockDirOf(root), `${gen}.json`), 'utf8'));

async function acquire(t, root, opts = {}) {
  const lock = await acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET, ...opts });
  t.after(() => lock.releaseSync());
  return lock;
}

function connectOnce(address) {
  return new Promise((resolve) => {
    const s = net.connect({ path: address });
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (e) => resolve(e.code));
  });
}

function spawnHolder(t, root, args = []) {
  const child = spawn(process.execPath, [HOLDER, root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => { out.stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { out.stderr += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  const waitFor = async (re, timeout = 20_000) => {
    const start = Date.now();
    for (;;) {
      const m = re.exec(out.stdout);
      if (m) return m;
      if (child.exitCode !== null || child.signalCode !== null || Date.now() - start > timeout) {
        throw new Error(`holder never printed ${re}\nstdout=${out.stdout}\nstderr=${out.stderr}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { child, out, exited, waitFor };
}

async function killHolder(h, signal) {
  h.child.kill(signal);
  await h.exited;
}

test('a fresh root: generation 1 names a socket that accepts a connection', async (t) => {
  const root = await freshRoot(t);
  const lock = await acquire(t, root);
  assert.equal(lock.gen, 1);
  assert.deepEqual(genFiles(root), ['1.json']);
  const rec = readRec(root, 1);
  assert.equal(rec.token, lock.token);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.handoverTo, null);
  const addr = hostPlatform.socketConnectPath(lockDirOf(root), rec.sock);
  try { assert.equal(await connectOnce(addr.path), 'connected'); } finally { addr.release(); }
});

test('a live holder is refused whatever pid its record names — pid plays no part', async (t) => {
  const root = await freshRoot(t);
  const h = spawnHolder(t, root);
  await h.waitFor(/HELD 1\n/);
  const file = path.join(lockDirOf(root), '1.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  // As a reader in another pid namespace sees it: no such pid, or our own.
  for (const pid of [2 ** 22 - 1, process.pid]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, pid }));
    await assert.rejects(
      acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET }),
      (e) => e instanceof RootLockHeldError && e.code === 'ROOT_LOCK_HELD' && e.holderPid === pid,
      `pid ${pid}`,
    );
  }
  assert.deepEqual(genFiles(root), ['1.json'], 'a refused contender leaves no generation behind');
});

test('a holder whose event loop is starved still probes alive', async (t) => {
  const root = await freshRoot(t);
  const h = spawnHolder(t, root, ['--busy-ms', '3000']);
  await h.waitFor(/HELD 1\n/);
  const until = Number((await h.waitFor(/BUSY-UNTIL (\d+)\n/))[1]);
  await assert.rejects(acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET }), RootLockHeldError);
  assert.ok(Date.now() < until, 'the refusal came while the holder was still blocked');
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`a holder killed by ${signal} is superseded at once; its generation and socket are collected`, async (t) => {
    const root = await freshRoot(t);
    const h = spawnHolder(t, root);
    await h.waitFor(/HELD 1\n/);
    const deadSock = path.join(lockDirOf(root), readRec(root, 1).sock.name);
    await killHolder(h, signal);
    assert.ok(fs.existsSync(deadSock), 'a signal death runs no exit handler: the socket file stays');
    const lock = await acquire(t, root);
    assert.equal(lock.gen, 2);
    assert.deepEqual(genFiles(root), ['2.json']);
    assert.ok(!fs.existsSync(deadSock), 'the dead holder\'s socket file is collected');
  });
}

test('after a reboot the last record names a socket nothing listens on: taken at the next generation without delay', async (t) => {
  const root = await freshRoot(t);
  const first = spawnHolder(t, root);
  await first.waitFor(/HELD 1\n/);
  await killHolder(first, 'SIGKILL');
  const second = spawnHolder(t, root);
  await second.waitFor(/HELD 2\n/);
  const sockFile = path.join(lockDirOf(root), readRec(root, 2).sock.name);
  await killHolder(second, 'SIGKILL');
  assert.ok(fs.existsSync(sockFile), 'the socket file survives the holder');
  const started = Date.now();
  const lock = await acquire(t, root);
  // Well under the probe's 2 s doubt timeout: a refused connect is an answer.
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(lock.gen, 3);
});

test('concurrent contenders on a fresh root: exactly one holds', async (t) => {
  const N = 4;
  for (let round = 0; round < 20; round++) {
    await t.test(`round ${round}`, async (st) => {
      const root = await freshRoot(st);
      const hs = Array.from({ length: N }, () => spawnHolder(st, root, ['--wait-go']));
      await Promise.all(hs.map((h) => h.waitFor(/READY\n/)));
      for (const h of hs) h.child.stdin.write('go\n');
      const outcomes = await Promise.all(hs.map((h) => h.waitFor(/(HELD \d+|REFUSED \d+)\n/).then((m) => m[1])));
      const held = outcomes.filter((o) => o.startsWith('HELD'));
      assert.equal(held.length, 1, `outcomes: ${outcomes.join(', ')}`);
      const refused = hs.filter((_, i) => outcomes[i].startsWith('REFUSED'));
      for (const h of refused) assert.equal((await h.exited).code, ROOT_LOCK_HELD_EXIT);
      const holder = hs[outcomes.indexOf(held[0])];
      assert.equal(readRec(root, Number(held[0].split(' ')[1])).pid, holder.child.pid);
    });
  }
});

// An unreadable top record is never superseded — on a filesystem without hard
// links it can be a live holder's, caught between its create and its write.
const SOCK_BASE = { v: 1, pid: 1, token: 't', handoverTo: null };
for (const [label, body] of [
  ['empty', ''],
  ['unparseable', '{"v":1,"pid":'],
  ['`.` store-socket', JSON.stringify({ ...SOCK_BASE, sock: { kind: 'store', name: '.' } })],
  ['`..` store-socket', JSON.stringify({ ...SOCK_BASE, sock: { kind: 'store', name: '..' } })],
]) {
  test(`an ${label} top record refuses the boot with RootLockUnreadableError and is left in place`, async (t) => {
    const root = await freshRoot(t);
    fs.mkdirSync(lockDirOf(root), { recursive: true });
    const file = path.join(lockDirOf(root), '1.json');
    fs.writeFileSync(file, body);
    await assert.rejects(
      acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET }),
      (e) => e instanceof RootLockUnreadableError && e.code === 'ROOT_LOCK_UNREADABLE' && e.lockPath === file && e.message.includes(file),
    );
    assert.deepEqual(genFiles(root), ['1.json']);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
    assert.deepEqual(fs.readdirSync(lockDirOf(root)).filter((n) => n.endsWith('.sock')), [], 'the refused contender closed its socket');
  });
}

test('probeHolder: a recorded socket that refuses is dead, one that accepts is alive', async (t) => {
  const root = await freshRoot(t);
  const lock = await acquire(t, root);
  const rec = readRec(root, lock.gen);
  assert.equal(await probeHolder(rec, lockDirOf(root), hostPlatform), 'alive');
  assert.equal(await probeHolder({ ...rec, sock: { kind: 'store', name: 'nobody.sock' } }, lockDirOf(root), hostPlatform), 'dead');
});

// ── Endpoint choice ────────────────────────────────────────────────────────

async function longRoot(t) {
  const root = await freshRoot(t);
  const deep = path.join(root, 'a'.repeat(60), 'b'.repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  return deep;
}

test('endpoint: a short store path listens in the store', async (t) => {
  const root = await freshRoot(t);
  const platform = createPosixPlatform();
  assert.equal(platform.rootLockEndpoint(lockDirOf(root), 'abcd1234').kind, 'store');
});

test('endpoint: a long Linux store path still listens in the store, reached through /proc/self/fd', async (t) => {
  if (!fs.existsSync('/proc/self/fd')) { t.skip('no /proc on this host'); return; }
  const root = await longRoot(t);
  const platform = createPosixPlatform({ procFd: () => true });
  assert.equal(platform.rootLockEndpoint(lockDirOf(root), 'abcd1234').kind, 'store');
  const lock = await acquire(t, root, { platform });
  const rec = readRec(root, lock.gen);
  assert.equal(rec.sock.kind, 'store');
  const addr = platform.socketConnectPath(lockDirOf(root), rec.sock);
  try {
    assert.match(addr.path, /^\/proc\/self\/fd\/\d+\//);
    assert.equal(await connectOnce(addr.path), 'connected');
  } finally { addr.release(); }
  await assert.rejects(acquireRootLock({ storeDir: storeOf(root), platform, log: QUIET }), RootLockHeldError);
});

test('endpoint: a long store path with no /proc listens in tmp', async (t) => {
  const root = await longRoot(t);
  const tmp = await freshRoot(t);
  const platform = createPosixPlatform({ procFd: () => false, tmpdir: () => tmp });
  const lock = await acquire(t, root, { platform });
  const rec = readRec(root, lock.gen);
  assert.equal(rec.sock.kind, 'tmp');
  assert.equal(path.dirname(rec.sock.path), tmp);
  const addr = platform.socketConnectPath(lockDirOf(root), rec.sock);
  try { assert.equal(await connectOnce(addr.path), 'connected'); } finally { addr.release(); }
  await assert.rejects(acquireRootLock({ storeDir: storeOf(root), platform, log: QUIET }), RootLockHeldError);
});

test('endpoint: a store that cannot hold a socket falls back to tmp, with a warning', async (t) => {
  const root = await freshRoot(t);
  const tmp = await freshRoot(t);
  const base = createPosixPlatform({ tmpdir: () => tmp });
  // A store whose socket address cannot be bound (its directory is missing).
  const platform = {
    ...base,
    socketConnectPath: (lockDir, sock) => (sock.kind === 'store'
      ? { path: path.join(lockDir, 'missing-dir', sock.name), release() {} }
      : base.socketConnectPath(lockDir, sock)),
  };
  const warnings = [];
  const lock = await acquireRootLock({ storeDir: storeOf(root), platform, log: { warn: (m) => warnings.push(m) } });
  t.after(() => lock.releaseSync());
  const rec = readRec(root, lock.gen);
  assert.equal(rec.sock.kind, 'tmp');
  assert.equal(warnings.length, 1);
  assert.equal(await connectOnce(rec.sock.path), 'connected');
});

test('endpoint: Windows listens on a named pipe keyed by the lock dir and token', () => {
  const platform = createWin32Platform({ realpathNative: (p) => p });
  const sock = platform.rootLockEndpoint('C:\\p\\.code-conductor\\server-lock', 'abcd1234');
  assert.equal(sock.kind, 'pipe');
  assert.match(sock.name, /^\\\\\.\\pipe\\cc-root-[0-9a-f]{16}-abcd1234$/);
  const other = platform.rootLockEndpoint('C:\\q\\.code-conductor\\server-lock', 'abcd1234');
  assert.notEqual(other.name, sock.name, 'two roots never share a pipe');
  assert.equal(platform.socketConnectPath('C:\\p', sock).path, sock.name);
});

// ── Handover and release ───────────────────────────────────────────────────

test('handover: the offered replacement publishes the next generation over its live parent; the parent then removes its own', async (t) => {
  const root = await freshRoot(t);
  const parent = await acquire(t, root);
  assert.equal(parent.offerHandover('T2'), true);
  assert.equal(readRec(root, parent.gen).handoverTo, 'T2');
  const env = { [ROOT_LOCK_HANDOVER_ENV]: 'T2', OTHER: 'x' };
  const child = await acquire(t, root, { env });
  assert.equal(child.gen, parent.gen + 1);
  assert.notEqual(child.token, 'T2', 'the offer authorises; the child holds under its own token');
  assert.deepEqual(env, { OTHER: 'x' }, 'the offer is consumed from the env');
  const rec = readRec(root, child.gen);
  assert.equal(rec.token, child.token);
  assert.equal(rec.handoverTo, null);
  assert.deepEqual(genFiles(root), ['1.json', '2.json'], 'the live parent\'s record is not collected');
  assert.equal(await parent.awaitAdoption({ timeoutMs: 1000 }), true);
  parent.releaseSync();
  assert.deepEqual(genFiles(root), ['2.json'], 'the parent removes its own record');
  assert.equal(await probeHolder(rec, lockDirOf(root), hostPlatform), 'alive', 'the child still answers after the parent closed');
  await assert.rejects(acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET }), RootLockHeldError);
});

// The record a parent leaves when it dies by a signal while offering T2: still
// offering, naming a socket nothing listens on any more. (A clean exit —
// including one on the handover wait's timeout — runs the exit handler, which
// removes the record.)
async function signalKilledOfferingParent(t, root) {
  const parent = await acquire(t, root);
  parent.offerHandover('T2');
  const file = path.join(lockDirOf(root), `${parent.gen}.json`);
  const left = fs.readFileSync(file, 'utf8');
  parent.releaseSync();
  fs.writeFileSync(file, left);
  return parent.gen;
}

// Run `fn` once, at the first publish of the acquire it is passed to.
const onceBeforePublish = (fn) => {
  let done = false;
  return { beforePublish: async (gen) => { if (!done) { done = true; await fn(gen); } } };
};

test('handover race: a third server that supersedes the signal-killed offering parent while the child is preempted holds alone', async (t) => {
  const root = await freshRoot(t);
  const parentGen = await signalKilledOfferingParent(t, root);
  let third;
  // The child has read the offer and staged its record when it is preempted;
  // the third server judges the parent dead and takes the root meanwhile.
  const child = acquireRootLock({
    storeDir: storeOf(root), platform: hostPlatform, log: QUIET, env: { [ROOT_LOCK_HANDOVER_ENV]: 'T2' },
    hooks: onceBeforePublish(async () => { third = await acquire(t, root); }),
  });
  await assert.rejects(child, RootLockHeldError, 'the child meets the third server\'s live generation and is refused');
  assert.equal(third.gen, parentGen + 1);
  assert.deepEqual(genFiles(root), [`${third.gen}.json`], 'one record, the third server\'s');
  assert.equal(readRec(root, third.gen).token, third.token);
  assert.equal(await probeHolder(readRec(root, third.gen), lockDirOf(root), hostPlatform), 'alive');
});

test('handover race: a child that publishes first holds alone; the third server meets it', async (t) => {
  const root = await freshRoot(t);
  const parentGen = await signalKilledOfferingParent(t, root);
  // The third server judged the dead parent too, and is preempted with its record staged.
  let child;
  const third = acquireRootLock({
    storeDir: storeOf(root), platform: hostPlatform, log: QUIET,
    hooks: onceBeforePublish(async () => { child = await acquire(t, root, { env: { [ROOT_LOCK_HANDOVER_ENV]: 'T2' } }); }),
  });
  await assert.rejects(third, RootLockHeldError);
  assert.equal(child.gen, parentGen + 1);
  assert.deepEqual(genFiles(root), [`${child.gen}.json`]);
});

const stagedFiles = (root) => fs.readdirSync(lockDirOf(root)).filter((n) => n.includes('.tmp-'));

test('a starved creator\'s staged record is invisible and swept: a contender takes the root, and the creator then meets it', async (t) => {
  const root = await freshRoot(t);
  let contender;
  let seenWhilePaused;
  let stagedAfterContender;
  const creator = acquireRootLock({
    storeDir: storeOf(root), platform: hostPlatform, log: QUIET,
    hooks: onceBeforePublish(async () => {
      seenWhilePaused = genFiles(root);
      contender = await acquire(t, root);
      stagedAfterContender = stagedFiles(root);
    }),
  });
  // Its publish fails ENOENT (the record was swept); it looks again and is refused.
  await assert.rejects(creator, RootLockHeldError);
  assert.deepEqual(seenWhilePaused, [], 'a staged record is no generation');
  assert.deepEqual(stagedAfterContender, [], 'the new holder swept the creator\'s staged record');
  assert.equal(contender.gen, 1);
  assert.deepEqual(genFiles(root), ['1.json']);
  assert.deepEqual(fs.readdirSync(lockDirOf(root)).filter((n) => n.includes('.tmp-')), [], 'no staging file is left behind');
});

test('a token that collides with a live holder\'s never takes its socket: the contender mints another and is refused', async (t) => {
  const root = await freshRoot(t);
  const holder = await acquire(t, root, { mintToken: () => 'SAME' });
  const rec = readRec(root, holder.gen);
  const holderSock = path.join(lockDirOf(root), rec.sock.name);
  const minted = ['SAME', 'OTHER'];
  await assert.rejects(
    acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET, mintToken: () => minted.shift() }),
    RootLockHeldError,
  );
  assert.deepEqual(minted, [], 'the colliding token was replaced');
  assert.ok(fs.existsSync(holderSock), 'the holder\'s socket file survives');
  assert.equal(await probeHolder(readRec(root, holder.gen), lockDirOf(root), hostPlatform), 'alive');
});

test('a contender whose every minted token collides gives up without touching the holder', async (t) => {
  const root = await freshRoot(t);
  const holder = await acquire(t, root, { mintToken: () => 'SAME' });
  await assert.rejects(
    acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET, mintToken: () => 'SAME' }),
    /minted tokens each named a socket/,
  );
  assert.equal(await probeHolder(readRec(root, holder.gen), lockDirOf(root), hostPlatform), 'alive');
});

test('a successful acquire sweeps leftover staged records and link-probe files from the lock dir', async (t) => {
  const root = await freshRoot(t);
  fs.mkdirSync(lockDirOf(root), { recursive: true });
  for (const n of ['4.json.tmp-deadbeef', `${LINK_PROBE_PREFIX}cafe`, `${LINK_PROBE_PREFIX}cafe.link`]) {
    fs.writeFileSync(path.join(lockDirOf(root), n), '');
  }
  const lock = await acquire(t, root);
  const left = fs.readdirSync(lockDirOf(root)).sort();
  assert.deepEqual(left, [`${lock.gen}.json`, readRec(root, lock.gen).sock.name].sort());
});

test('a socket path that a listener takes between the last probe and the bind is \'taken\': the contender mints again and proceeds', async (t) => {
  const root = await freshRoot(t);
  const minted = ['FIRST', 'SECOND'];
  const blocker = net.createServer((s) => s.destroy());
  t.after(() => blocker.close());
  let blocked;
  const lock = await acquire(t, root, {
    mintToken: () => minted.shift(),
    hooks: {
      beforeListen: async (address) => {
        if (blocked) return;
        blocked = address;
        await new Promise((resolve) => blocker.listen(address, resolve));
      },
    },
  });
  assert.deepEqual(minted, [], 'a second token was minted');
  assert.equal(lock.gen, 1);
  assert.notEqual(path.join(lockDirOf(root), readRec(root, 1).sock.name), blocked, 'it holds at the second token\'s path');
  assert.equal(await connectOnce(blocked), 'connected', 'the other listener keeps its socket');
});

test('collection keeps a lower generation whose socket still answers', async (t) => {
  const root = await freshRoot(t);
  const low = await acquire(t, root);
  // A dead higher generation above the live one (as left by a crashed replacement).
  fs.writeFileSync(path.join(lockDirOf(root), '2.json'),
    JSON.stringify({ v: 1, pid: 1, token: 'dead', sock: { kind: 'store', name: 'dead.sock' }, handoverTo: null }));
  const lock = await acquire(t, root);
  assert.equal(lock.gen, 3);
  assert.deepEqual(genFiles(root), ['1.json', '3.json'], 'the dead generation goes, the answering one stays');
  assert.equal(readRec(root, 1).token, low.token);
});

test('handover: a token the live holder never offered is refused', async (t) => {
  const root = await freshRoot(t);
  const parent = await acquire(t, root);
  parent.offerHandover('T2');
  await assert.rejects(
    acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, env: { [ROOT_LOCK_HANDOVER_ENV]: 'T3' }, log: QUIET }),
    RootLockHeldError,
  );
  await assert.rejects(
    acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET }),
    RootLockHeldError,
    'nor is a contender presenting none',
  );
  assert.equal(await parent.awaitAdoption({ timeoutMs: 150 }), false, 'nobody adopted');
});

test('awaitAdoption stops waiting when its signal aborts', async (t) => {
  const root = await freshRoot(t);
  const lock = await acquire(t, root);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const started = Date.now();
  assert.equal(await lock.awaitAdoption({ timeoutMs: 60_000, signal: ac.signal }), false);
  assert.ok(Date.now() - started < 5000);
});

test('releaseSync removes our record and our socket file', async (t) => {
  const root = await freshRoot(t);
  const lock = await acquire(t, root);
  const sockFile = path.join(lockDirOf(root), readRec(root, lock.gen).sock.name);
  assert.ok(fs.existsSync(sockFile));
  lock.releaseSync();
  assert.deepEqual(genFiles(root), []);
  assert.ok(!fs.existsSync(sockFile));
  const next = await acquire(t, root);
  assert.equal(next.gen, 1);
});
