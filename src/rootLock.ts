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
// Records are generation-numbered (`<gen>.json`, the highest is the lock). A
// contender supersedes a dead holder's generation and never deletes it before
// its own is confirmed, so two contenders reclaiming at once cannot unlink each
// other's fresh lock.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Platform } from './platform/index.ts';
import type { RootLockSock, SocketAddress } from './platform/platform.ts';
import { createLockFileSync, mintLockToken, releaseLockSync } from './storeLock.ts';

export const ROOT_LOCK_DIRNAME = 'server-lock';
// Internal, restart parent → child: the token the child adopts the lock under.
export const ROOT_LOCK_HANDOVER_ENV = 'CC_ROOT_LOCK_HANDOVER';
// How long a restarting parent waits for its replacement to adopt the lock,
// sized for Termux's throttled module load.
export const ROOT_LOCK_HANDOVER_WAIT_MS = Number(process.env.CC_ROOT_LOCK_HANDOVER_WAIT_MS) || 120_000;

// The exit code of a server refused because another holds its projects root.
export const ROOT_LOCK_HELD_EXIT = 7;

const PROBE_TIMEOUT_MS = 2000;
const ACQUIRE_ATTEMPTS = 50;
const BAD_RECORD_REREADS = 3;
const BAD_RECORD_REREAD_MS = 20;
const ADOPTION_POLL_MS = 100;
const GEN_FILE = /^([1-9]\d*)\.json$/;

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
  // Name `next` as the token a replacement may adopt this generation under.
  // False when the record is no longer ours.
  offerHandover(next: string): boolean;
  withdrawHandover(): void;
  // Resolves true once the record no longer carries our token (adopted, or
  // superseded), false on the timeout or when `signal` aborts.
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

interface Log { warn: (...args: unknown[]) => void }

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
  if (kind === 'store' && typeof name === 'string' && name !== '' && path.basename(name) === name) return { kind, name };
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

// A record as a contender judges it. The create is one synchronous block, so
// only a process killed inside it leaves a bad file — re-read a few times
// before calling it that.
async function readRecordSettled(file: string): Promise<RootLockRecord | 'missing' | 'bad'> {
  for (let i = 0; ; i++) {
    const raw = readRaw(file);
    if (raw === 'missing') return 'missing';
    const rec = parseRootLockRecord(raw);
    if (rec) return rec;
    if (i >= BAD_RECORD_REREADS) return 'bad';
    await sleep(BAD_RECORD_REREAD_MS);
  }
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

async function listenOn(lockDir: string, sock: RootLockSock, platform: Platform): Promise<Listener> {
  const addr = platform.socketConnectPath(lockDir, sock);
  try {
    // A leftover at our own path is ours by construction: the name carries a
    // hash of this process's unique token.
    if (sock.kind !== 'pipe') fs.rmSync(addr.path, { force: true });
    const server = net.createServer((s) => { s.on('error', () => {}); s.destroy(); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: addr.path, readableAll: true, writableAll: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', () => {});
    server.unref();
    return { sock, server, addr };
  } catch (e) {
    addr.release();
    throw e;
  }
}

async function listenHolder(lockDir: string, token8: string, platform: Platform, log: Log): Promise<Listener> {
  const sock = platform.rootLockEndpoint(lockDir, token8);
  try {
    return await listenOn(lockDir, sock, platform);
  } catch (e) {
    if (sock.kind !== 'store' || errCode(e) === 'EADDRINUSE') throw e;
    const fallback = platform.rootLockEndpoint(lockDir, token8, { storeUsable: false });
    log.warn(`root lock: ${lockDir} cannot hold a socket (${errCode(e) ?? String(e)}); listening at ${fallback.kind === 'tmp' ? fallback.path : fallback.name} instead — a server in another container sharing this projects root will not see this one`);
    return await listenOn(lockDir, fallback, platform);
  }
}

// Replace `file` atomically. Windows refuses a rename onto a file another
// process has open for a moment, so EPERM/EBUSY are retried.
function writeAtomicSync(file: string, content: string, token8: string): void {
  const tmp = `${file}.tmp-${token8}`;
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

function sockFile(lockDir: string, sock: RootLockSock): string | null {
  if (sock.kind === 'store') return path.join(lockDir, sock.name);
  if (sock.kind === 'tmp') return sock.path;
  return null;
}

// Drop every generation below ours, and the socket file of each one whose
// holder is dead. A socket that still answers is left alone.
async function collectBelow(lockDir: string, mine: number, own: RootLockSock, platform: Platform): Promise<void> {
  for (const g of listGens(lockDir)) {
    if (g >= mine) continue;
    const file = genPath(lockDir, g);
    let rec: RootLockRecord | null = null;
    try { rec = parseRootLockRecord(fs.readFileSync(file, 'utf8')); } catch { /* gone */ }
    fs.rmSync(file, { force: true });
    if (!rec) continue;
    const sf = sockFile(lockDir, rec.sock);
    if (!sf || sf === sockFile(lockDir, own)) continue;
    if (await probeHolder(rec, lockDir, platform) === 'dead') {
      const addr = platform.socketConnectPath(lockDir, rec.sock);
      try { fs.rmSync(addr.path, { force: true }); } finally { addr.release(); }
    }
  }
}

export async function acquireRootLock({
  storeDir, platform, env = process.env, log = console,
}: { storeDir: string; platform: Platform; env?: NodeJS.ProcessEnv; log?: Log }): Promise<RootLock> {
  const lockDir = path.join(storeDir, ROOT_LOCK_DIRNAME);
  const root = path.dirname(storeDir);
  fs.mkdirSync(lockDir, { recursive: true });
  // Read once and dropped, so it never reaches a CLI or plugin env.
  const handover = env[ROOT_LOCK_HANDOVER_ENV] || null;
  delete env[ROOT_LOCK_HANDOVER_ENV];
  const token = handover ?? mintLockToken();
  const token8 = tokenHash8(token);
  // Listen BEFORE any record names us: a record is probe-able from the moment
  // it exists, so no contender can read a fresh one as dead.
  const listener = await listenHolder(lockDir, token8, platform, log);
  const record = (handoverTo: string | null): string =>
    JSON.stringify({ v: 1, pid: process.pid, token, sock: listener.sock, handoverTo } satisfies RootLockRecord);
  try {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      const top = maxGen(listGens(lockDir));
      if (top !== undefined) {
        const rec = await readRecordSettled(genPath(lockDir, top));
        if (rec === 'missing') continue; // released under us — look again
        if (rec !== 'bad') {
          if (handover && rec.handoverTo === handover) {
            writeAtomicSync(genPath(lockDir, top), record(null), token8);
            return holdLock(lockDir, top, token, token8, listener, record);
          }
          if (await probeHolder(rec, lockDir, platform) === 'alive') {
            throw new RootLockHeldError(root, rec.pid, genPath(lockDir, top));
          }
        }
      }
      const mine = (top ?? 0) + 1;
      if (!createLockFileSync(genPath(lockDir, mine), record(null))) continue;
      // A contender that created a lower generation backs off here; the next
      // pass probes the higher one, which listened before it existed.
      if (maxGen(listGens(lockDir)) !== mine) {
        fs.rmSync(genPath(lockDir, mine), { force: true });
        continue;
      }
      await collectBelow(lockDir, mine, listener.sock, platform);
      return holdLock(lockDir, mine, token, token8, listener, record);
    }
    throw new Error(`root lock: could not settle ${lockDir} after ${ACQUIRE_ATTEMPTS} attempts`);
  } catch (e) {
    closeListener(listener);
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
    withdrawHandover: () => { rewrite(null); },
    async awaitAdoption({ timeoutMs, signal }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!ours()) return true;
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
