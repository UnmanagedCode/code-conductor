// The projects-root lock: at most one cc server runs on a projects root at a
// time, across the host and every container that mounts the root on the same
// kernel. Layout, record and handover: docs/architecture.md → "The
// projects-root lock".
//
// A holder is judged ONLY by whether the socket its record names accepts a
// connection — never by its pid. A pid means nothing to a reader in another pid
// namespace (two containers sharing one bind-mounted store, or a host and a
// container): it reads as absent, or as the reader's own pid, and either would
// steal a live lock. The kernel closes a dead holder's listener whatever killed
// it, and completes a connect into the backlog of a live holder whose event
// loop is starved, so the probe needs no exit handler and no age rule.
//
// Records are generation-numbered (`<gen>.json`, the highest is the lock) and
// every holder — a restart's replacement included — takes the lock the same
// way: publish the next generation exclusively, confirm it is the highest,
// then collect the dead ones below. A record is never rewritten into a lock
// and never deleted while its socket answers, so a contender that judged a
// generation dead can never make a second holder out of it.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Platform } from './platform/index.ts';
import type { RootLockSock, SocketAddress } from './platform/platform.ts';
import { LINK_PROBE_PREFIX, STAGED_SUFFIX_HEX, mintLockToken, prepareLockFileSync, releaseLockSync } from './storeLock.ts';

export const ROOT_LOCK_DIRNAME = 'server-lock';
// Internal, restart parent → child: the offer that lets the child take the
// next generation over its live parent's.
export const ROOT_LOCK_HANDOVER_ENV = 'CC_ROOT_LOCK_HANDOVER';
// How long a restarting parent waits for its replacement to adopt the lock,
// sized for Termux's throttled module load.
export const ROOT_LOCK_HANDOVER_WAIT_MS = Number(process.env.CC_ROOT_LOCK_HANDOVER_WAIT_MS) || 120_000;

// The exit code of a server refused because another holds its projects root,
// or because the root's lock record cannot be read.
export const ROOT_LOCK_HELD_EXIT = 7;

const PROBE_TIMEOUT_MS = 2000;
const ACQUIRE_ATTEMPTS = 50;
// Fresh tokens to try when a minted one names a socket something answers on.
const TOKEN_ATTEMPTS = 5;
const ADOPTION_POLL_MS = 100;
const GEN_FILE = /^([1-9]\d*)\.json$/;
// A generation record staged for publishing — exactly storeLock's
// `<lock>.tmp-<hex>` shape, so nothing else in the lock dir matches.
const STAGED_GEN_FILE = new RegExp(`^[1-9]\\d*\\.json\\.tmp-[0-9a-f]{${STAGED_SUFFIX_HEX * 2}}$`);

export interface RootLockRecord {
  v: 1;
  pid: number;
  token: string;
  sock: RootLockSock;
  handoverTo: string | null;
}

export interface RootLock {
  dir: string;
  gen: number;
  token: string;
  // Offer the next generation to a replacement presenting `next`. False when
  // the record is no longer ours.
  offerHandover(next: string): boolean;
  // Resolves true once a higher generation exists or our record no longer
  // carries our token, false on the timeout or when `signal` aborts.
  awaitAdoption(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<boolean>;
  releaseSync(): void;
}

export class RootLockHeldError extends Error {
  readonly code = 'ROOT_LOCK_HELD';
  readonly holderPid: number;
  readonly lockPath: string;
  constructor(root: string, holderPid: number, lockPath: string) {
    super(`another code-conductor server (pid ${holderPid}) holds the projects root ${root} (${lockPath}); refusing to start`);
    this.name = 'RootLockHeldError';
    this.holderPid = holderPid;
    this.lockPath = lockPath;
  }
}

// A top record nothing can parse. It may be a live holder's, mid-create on a
// filesystem without hard links, so it is never superseded: boot stops until
// someone who knows no server runs deletes it.
export class RootLockUnreadableError extends Error {
  readonly code = 'ROOT_LOCK_UNREADABLE';
  readonly lockPath: string;
  constructor(root: string, lockPath: string) {
    super(`the projects-root lock record ${lockPath} cannot be read; if no code-conductor server is running on ${root}, delete it and start again`);
    this.name = 'RootLockUnreadableError';
    this.lockPath = lockPath;
  }
}

interface Log { warn: (...args: unknown[]) => void }

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Test seams. `beforePublish` runs between preparing a generation's record and
// publishing it — the window a starved or preempted creator sits in;
// `beforeListen` between a socket path's last probe and its bind.
export interface AcquireHooks {
  beforePublish?: (gen: number) => Promise<void>;
  beforeListen?: (address: string) => Promise<void>;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function tokenHash8(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

function parseSock(v: unknown): RootLockSock | null {
  if (typeof v !== 'object' || v === null) return null;
  const { kind, name, path: p } = v as { kind?: unknown; name?: unknown; path?: unknown };
  if (kind === 'store' && typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && path.basename(name) === name) return { kind, name };
  if (kind === 'tmp' && typeof p === 'string' && path.isAbsolute(p)) return { kind, path: p };
  if (kind === 'pipe' && typeof name === 'string' && name !== '') return { kind, name };
  return null;
}

export function parseRootLockRecord(raw: string): RootLockRecord | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, pid, token, sock, handoverTo } = parsed as Record<string, unknown>;
  const s = parseSock(sock);
  if (v !== 1 || typeof pid !== 'number' || typeof token !== 'string' || !s) return null;
  if (handoverTo !== null && typeof handoverTo !== 'string') return null;
  return { v: 1, pid, token, sock: s, handoverTo };
}

const genPath = (dir: string, gen: number): string => path.join(dir, `${gen}.json`);

function listGens(dir: string): number[] {
  const out: number[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = GEN_FILE.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

const maxGen = (gens: number[]): number | undefined => (gens.length ? Math.max(...gens) : undefined);

function readRaw(file: string): string | 'missing' {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') return 'missing';
    throw e;
  }
}

// 'bad' is a record nothing can parse: corruption, or — where the filesystem has
// no hard links — a holder's record caught between its create and its write.
function readRecord(file: string): RootLockRecord | 'missing' | 'bad' {
  const raw = readRaw(file);
  if (raw === 'missing') return 'missing';
  return parseRootLockRecord(raw) ?? 'bad';
}

// Connect to `address`. A connection is a live holder; ECONNREFUSED/ENOENT a
// dead one; anything else — a timeout, a full backlog, a permission error —
// is read as alive, so a doubtful holder is never superseded.
function probeAddress(address: string): Promise<'alive' | 'dead'> {
  return new Promise((resolve) => {
    let settled = false;
    let sock: net.Socket | undefined;
    const finish = (v: 'alive' | 'dead'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish('alive'), PROBE_TIMEOUT_MS);
    try {
      sock = net.connect({ path: address });
    } catch {
      finish('alive');
      return;
    }
    sock.once('connect', () => finish('alive'));
    sock.once('error', (e) => {
      const code = errCode(e);
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'dead' : 'alive');
    });
  });
}

export async function probeHolder(rec: RootLockRecord, lockDir: string, platform: Platform): Promise<'alive' | 'dead'> {
  const addr = platform.socketConnectPath(lockDir, rec.sock);
  try { return await probeAddress(addr.path); }
  finally { addr.release(); }
}

interface Listener { sock: RootLockSock; server: net.Server; addr: SocketAddress }
interface Holder extends Listener { token: string; token8: string }

// Listen at `sock`, or 'taken' when something already answers there.
//
// What holds: a file at our path is unlinked only after a probe found no
// listener answering on it, and the path is probed again after the unlink, so
// a listener that bound in between makes the path 'taken'; one that binds after
// that second probe makes our bind fail EADDRINUSE, also 'taken'. What does
// not: a listener that binds between the first probe and the unlink loses its
// file to it. Only two holders minting tokens with one sha256 prefix
// (`token8`) can share a path, and tokens carry 8 random bytes.
async function listenOn(lockDir: string, sock: RootLockSock, platform: Platform, hooks: AcquireHooks): Promise<Listener | 'taken'> {
  const addr = platform.socketConnectPath(lockDir, sock);
  try {
    if (await probeAddress(addr.path) === 'alive') { addr.release(); return 'taken'; }
    if (sock.kind !== 'pipe') {
      fs.rmSync(addr.path, { force: true });
      if (await probeAddress(addr.path) === 'alive') { addr.release(); return 'taken'; }
    }
    await hooks.beforeListen?.(addr.path);
    const server = net.createServer((s) => { s.on('error', () => {}); s.destroy(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: addr.path, readableAll: true, writableAll: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      if (errCode(e) !== 'EADDRINUSE') throw e;
      addr.release();
      return 'taken';
    }
    server.on('error', () => {});
    server.unref();
    return { sock, server, addr };
  } catch (e) {
    addr.release();
    throw e;
  }
}

async function listenHolder(lockDir: string, mintToken: () => string, platform: Platform, log: Log, hooks: AcquireHooks): Promise<Holder> {
  for (let i = 0; i < TOKEN_ATTEMPTS; i++) {
    const token = mintToken();
    const token8 = tokenHash8(token);
    const sock = platform.rootLockEndpoint(lockDir, token8);
    let l: Listener | 'taken';
    try {
      l = await listenOn(lockDir, sock, platform, hooks);
    } catch (e) {
      if (sock.kind !== 'store') throw e;
      const fallback = platform.rootLockEndpoint(lockDir, token8, { storeUsable: false });
      log.warn(`root lock: ${lockDir} cannot hold a socket (${errCode(e) ?? String(e)}); listening at ${fallback.kind === 'tmp' ? fallback.path : fallback.name} instead — a server in another container sharing this projects root will not see this one`);
      l = await listenOn(lockDir, fallback, platform, hooks);
    }
    if (l !== 'taken') return { ...l, token, token8 };
  }
  throw new Error(`root lock: ${TOKEN_ATTEMPTS} minted tokens each named a socket something already answers on`);
}

// Replace `file` atomically. Windows refuses a rename onto a file another
// process has open for a moment, so EPERM/EBUSY are retried.
// The temp carries its own suffix (`.offer-`), never the staging shape, so a new
// holder's sweep can never take an offer in flight.
function writeAtomicSync(file: string, content: string, token8: string): void {
  const tmp = `${file}.offer-${token8}`;
  fs.writeFileSync(tmp, content);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      const code = errCode(e);
      if ((code !== 'EPERM' && code !== 'EBUSY') || i >= 5) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(20);
    }
  }
}

// Drop every generation below ours whose holder is dead, with its socket file.
// One whose socket still answers is left alone — a contender between its
// publish and its confirm, or a restarting parent waiting to exit; each removes
// its own record. An unparseable one below ours cannot be the lock (ours is the
// confirmed highest): at most a contender's mid-create record, which backs off
// at its confirm. It is dropped, so it never surfaces as the top later.
async function collectBelow(lockDir: string, mine: number, platform: Platform): Promise<void> {
  for (const g of listGens(lockDir)) {
    if (g >= mine) continue;
    const file = genPath(lockDir, g);
    const rec = readRecord(file);
    if (rec === 'missing') continue;
    if (rec !== 'bad' && await probeHolder(rec, lockDir, platform) === 'alive') continue;
    fs.rmSync(file, { force: true });
    if (rec === 'bad' || rec.sock.kind === 'pipe') continue;
    const addr = platform.socketConnectPath(lockDir, rec.sock);
    try { fs.rmSync(addr.path, { force: true }); } finally { addr.release(); }
  }
}

// Drop staged generation records and link-probe files from the lock dir. A
// live creator's staged record belongs to a contender that will be refused:
// its publish fails ENOENT, and its next pass meets us. A live link probe
// retries (storeLock's probeLinks).
function sweepStaging(lockDir: string): void {
  for (const name of fs.readdirSync(lockDir)) {
    if (STAGED_GEN_FILE.test(name) || name.startsWith(LINK_PROBE_PREFIX)) fs.rmSync(path.join(lockDir, name), { force: true });
  }
}

export async function acquireRootLock({
  storeDir, platform, env = process.env, log = console, mintToken = mintLockToken, hooks = {},
}: {
  storeDir: string; platform: Platform; env?: NodeJS.ProcessEnv; log?: Log;
  mintToken?: () => string; hooks?: AcquireHooks;
}): Promise<RootLock> {
  const lockDir = path.join(storeDir, ROOT_LOCK_DIRNAME);
  const root = path.dirname(storeDir);
  fs.mkdirSync(lockDir, { recursive: true });
  // Read once and dropped, so it never reaches a CLI or plugin env.
  const handover = env[ROOT_LOCK_HANDOVER_ENV] || null;
  delete env[ROOT_LOCK_HANDOVER_ENV];
  // Listen BEFORE any record names us: a record is probe-able from the moment
  // it exists, so no contender can read a fresh one as dead.
  const holder = await listenHolder(lockDir, mintToken, platform, log, hooks);
  const { token, token8 } = holder;
  const record = (handoverTo: string | null): string =>
    JSON.stringify({ v: 1, pid: process.pid, token, sock: holder.sock, handoverTo } satisfies RootLockRecord);
  try {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      const top = maxGen(listGens(lockDir));
      if (top !== undefined) {
        const rec = readRecord(genPath(lockDir, top));
        if (rec === 'missing') continue; // released under us — look again
        if (rec === 'bad') throw new RootLockUnreadableError(root, genPath(lockDir, top));
        // A live top refuses us — unless it offered its successor to us. The
        // offer only skips this refusal; the generation is taken below like any.
        const offered = handover !== null && rec.handoverTo === handover;
        if (!offered && await probeHolder(rec, lockDir, platform) === 'alive') {
          throw new RootLockHeldError(root, rec.pid, genPath(lockDir, top));
        }
      }
      const mine = (top ?? 0) + 1;
      const pending = prepareLockFileSync(genPath(lockDir, mine), record(null));
      try { await hooks.beforePublish?.(mine); }
      catch (e) { pending.abandon(); throw e; }
      let published: boolean;
      try { published = pending.publish(); }
      catch (e) {
        // Our staged record was swept by a server that took the root meanwhile:
        // look again, and meet it.
        if (errCode(e) === 'ENOENT') continue;
        throw e;
      }
      // Taken by a contender that judged the same top: look again, and meet it.
      if (!published) continue;
      // A contender that published a lower generation backs off here; the next
      // pass probes the higher one, which listened before it existed.
      if (maxGen(listGens(lockDir)) !== mine) {
        fs.rmSync(genPath(lockDir, mine), { force: true });
        continue;
      }
      await collectBelow(lockDir, mine, platform);
      sweepStaging(lockDir);
      return holdLock(lockDir, mine, token, token8, holder, record);
    }
    throw new Error(`root lock: could not settle ${lockDir} after ${ACQUIRE_ATTEMPTS} attempts`);
  } catch (e) {
    closeListener(holder);
    throw e;
  }
}

function closeListener(l: Listener): void {
  try { l.server.close(); } catch { /* not listening */ }
  if (l.sock.kind !== 'pipe') { try { fs.rmSync(l.addr.path, { force: true }); } catch { /* gone */ } }
  l.addr.release();
}

function holdLock(
  dir: string, gen: number, token: string, token8: string, listener: Listener,
  record: (handoverTo: string | null) => string,
): RootLock {
  const file = genPath(dir, gen);
  const ours = (): boolean => {
    const raw = readRaw(file);
    return raw !== 'missing' && parseRootLockRecord(raw)?.token === token;
  };
  const rewrite = (handoverTo: string | null): boolean => {
    if (!ours()) return false;
    writeAtomicSync(file, record(handoverTo), token8);
    return true;
  };
  let released = false;
  const lock: RootLock = {
    dir, gen, token,
    offerHandover: (next) => rewrite(next),
    async awaitAdoption({ timeoutMs, signal }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!ours() || (maxGen(listGens(dir)) ?? 0) > gen) return true;
        if (signal?.aborted || Date.now() >= deadline) return false;
        await sleep(ADOPTION_POLL_MS);
      }
    },
    releaseSync() {
      if (released) return;
      released = true;
      process.off('exit', onExit);
      releaseLockSync(file, token);
      closeListener(listener);
    },
  };
  const onExit = (): void => lock.releaseSync();
  process.on('exit', onExit);
  return lock;
}
