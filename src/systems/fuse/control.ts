// THE CONTROL CHANNEL — cc's half. A unix stream socket, a fixed binary frame,
// and NO PAYLOAD EVER: the daemon says which path a caller reached, cc
// materialises it into the session's mirror, and no file content crosses the
// wire. That is what makes a malformed length a refusal rather than a buffer of
// attacker bytes.
//
// THE ONE RULE THAT MAKES A DEADLOCK STRUCTURALLY IMPOSSIBLE: this handler
// touches the MIRROR and the SOURCE ROOT, and never the mount. A FUSE thread is
// blocked waiting for the reply to the frame being served here, so a handler
// that stat'd anything under the union would be waiting on itself.
//
// The socket lives at `<rundir>/control.sock`. `rundir` is a SIBLING of the
// mount root and is tiered `hide`, so nothing inside the chroot can name it
// THROUGH THE UNION: `route()` answers -ENOENT for the path before any frame
// is sent. That is the whole of the property — it is NOT structural
// containment. The worker runs as cc's own uid and the architecture
// bind-mounts the orchestrator's real /proc, so
// `/proc/<ccpid>/root/<rundir>/control.sock` names and reaches this socket
// from inside the chroot today (measured; card 2026-0394 owns that route).

import net from 'node:net';
import path from 'node:path';
import { promises as fsp, constants as fsc, openSync, closeSync } from 'node:fs';
import { httpError } from '../../httpError.ts';
import { withinPosix } from '../mirror.ts';
import { resolveTierEntry, type TierEntry } from './tierTable.ts';
import { isSourceError, type RemoteSource } from './remoteSource.ts';
import { MAX_FILE_BYTES } from '../protocol.ts';

// ── the frame codec ─────────────────────────────────────────────────────────
//
// MUST MATCH `policy.h` BYTE FOR BYTE. Both sides emit the same canonical
// vectors and both tests assert them, which is the drift guard.
//
//   request: u32 magic 'CCU1' | u8 op | u8 flags | u16 pathlen | path[pathlen]
//   reply:   u32 magic 'CCU1' | u8 status | u8 pad | i32 errno | u32 reserved
//
// All multi-byte fields are BIG-ENDIAN, so the wire depends on neither word
// order nor struct padding.

export const CCU_MAGIC = 0x43435531;   // 'C' 'C' 'U' '1'
export const CCU_REQ_HDR = 8;
export const CCU_REPLY_LEN = 14;
export const CCU_MAX_PATH = 4096;

export const CCU_OP = { STAT: 1, LIST: 2, FETCH: 3, DIRTY: 4 } as const;
export const CCU_STATUS = { READY: 0, ABSENT: 1, REFUSED: 2 } as const;
// OP-SCOPED BITS in one flags byte — each is meaningful for exactly one op, and
// policy.h carries the same table. They exist because cc cannot tell the
// worker's intent from its own cache management, so the intent is declared.
export const CCU_FLAG_FOR_CREATE = 0x01;   // FETCH: the caller will CREATE `path`
export const CCU_FLAG_FOR_WRITE  = 0x02;   // FETCH: the caller will MUTATE it
export const CCU_FLAG_REMOVED    = 0x04;   // DIRTY: the worker REMOVED the entry
export const CCU_FLAG_RELEASE_ONLY = 0x08; // DIRTY: release the claim, carry nothing

export interface ControlRequest {
  op: number;
  forCreate: boolean;
  forWrite: boolean;
  removed: boolean;
  releaseOnly: boolean;
  path: string;
}

// Decode as many whole frames as `buf` holds. A frame this cc cannot act on —
// a bad magic, an over-long path — is fatal for the CONNECTION, not skippable:
// the stream is out of frame and every later byte would be misread.
export type DecodeResult =
  | { frames: ControlRequest[]; rest: Buffer }
  | { error: string };

export function decodeRequests(buf: Buffer): DecodeResult {
  const frames: ControlRequest[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < CCU_REQ_HDR) break;
    if (buf.readUInt32BE(off) !== CCU_MAGIC) {
      return { error: `bad magic 0x${buf.readUInt32BE(off).toString(16)} at offset ${off}` };
    }
    const op = buf[off + 4];
    const flags = buf[off + 5];
    const pathlen = buf.readUInt16BE(off + 6);
    if (pathlen > CCU_MAX_PATH) return { error: `path length ${pathlen} exceeds ${CCU_MAX_PATH}` };
    if (buf.length - off - CCU_REQ_HDR < pathlen) break;
    frames.push({
      op,
      forCreate: (flags & CCU_FLAG_FOR_CREATE) !== 0,
      forWrite: (flags & CCU_FLAG_FOR_WRITE) !== 0,
      removed: (flags & CCU_FLAG_REMOVED) !== 0,
      releaseOnly: (flags & CCU_FLAG_RELEASE_ONLY) !== 0,
      path: buf.toString('utf8', off + CCU_REQ_HDR, off + CCU_REQ_HDR + pathlen),
    });
    off += CCU_REQ_HDR + pathlen;
  }
  return { frames, rest: buf.subarray(off) };
}

export function encodeRequest(op: number, flags: number, p: string): Buffer {
  const bytes = Buffer.from(p, 'utf8');
  const out = Buffer.alloc(CCU_REQ_HDR + bytes.length);
  out.writeUInt32BE(CCU_MAGIC, 0);
  out[4] = op;
  out[5] = flags;
  out.writeUInt16BE(bytes.length, 6);
  bytes.copy(out, CCU_REQ_HDR);
  return out;
}

// `err` is CC'S: cc decides ENOENT/EACCES/EIO rather than the daemon inventing
// one from a status it did not choose.
export function encodeReply(status: number, err: number): Buffer {
  const out = Buffer.alloc(CCU_REPLY_LEN);
  out.writeUInt32BE(CCU_MAGIC, 0);
  out[4] = status;
  out[5] = 0;
  out.writeInt32BE(err, 6);
  out.writeUInt32BE(0, 10);
  return out;
}

// ── the per-path fault record ───────────────────────────────────────────────
//
// A PATH THIS SESSION COULD NOT RECONCILE, OR CANNOT CARRY AT ALL. Two kinds,
// and they differ in what stays reachable: a diverged path is still READABLE —
// the mirror holds the worker's own unpushed bytes and that is the recovery
// channel the refusal points at — while an over-cap path was never
// materialised at all, so there is nothing to read.
export type Fault =
  | { kind: 'diverged'; detail: string; refuses: 'writes' }
  | { kind: 'over-cap'; size: number; cap: number; refuses: 'all' };

// ── the socket's ADDRESS, which is not its path ─────────────────────────────
//
// Linux's `sockaddr_un` is `char sun_path[108]` and bind(2)/connect(2) need the
// terminating NUL, so 107 bytes is the whole budget for the address. The budget
// binds BOTH ends: the mechanism makes one syscall per side, bind(2) here and
// connect(2) in `union.c`. It lives here rather than in `plan.ts` because it
// governs those two calls, not any path on disk.
export const SUN_PATH_MAX = 107;

// THE ADDRESS, NOT THE PATH. The socket FILE is unmoved — it is still created
// at `<dirfd>/<name>`, i.e. `<rundir>/control.sock`, whose depth follows the
// store root's. What is bounded by construction is the STRING handed to the
// syscall: `/proc/self/fd/<dirfd>/<name>` resolves in the CALLING process's own
// fd table, so no store root, however deep, can overflow `sun_path`.
//
// IT ADDS NO REACHABLE OBJECT. A process inside the chroot has its own
// `/proc/self/fd`, holding its own fds, so the string is meaningless there;
// `<rundir>` keeps its `hide` pin and `route()` still answers -ENOENT for the
// socket's real path before any control frame is sent.
//
// The daemon forms the same address in `control_connect` (union.c) from an fd
// it opens per connect.
export function sunPathAddress(dirfd: number, name: string): string {
  const addr = `/proc/self/fd/${dirfd}/${name}`;
  const len = Buffer.byteLength(addr);
  if (len > SUN_PATH_MAX) {
    // A DIAGNOSTIC FOR A CASE THE MECHANISM MAKES UNREACHABLE, kept because a
    // bare EINVAL from bind(2) names neither a limit nor a measurement.
    // `/proc/self/fd/` (14) + the fd's decimal digits + the basename: at any
    // ordinary RLIMIT_NOFILE the fd is at most 7 digits, so this address tops
    // out around 34 bytes. THE STORE ROOT'S DEPTH IS NOT A FACTOR — it is not
    // in the address at all. Reaching the limit means cc chose a basename of
    // ~80 characters or an 80-digit fd number, both cc DEFECTS, so the repair
    // belongs at the caller that chose the basename, not at the operator.
    throw httpError(501, `FUSE_CONTROL_SOCK_PATH_TOO_LONG: the address this session would hand bind()/connect() is ${len} bytes and the limit is ${SUN_PATH_MAX} (Linux's sockaddr_un is char sun_path[108], one byte of it the terminating NUL). The address is ${addr}. It is formed from a directory fd, so the store root's depth is NOT a factor and moving the store somewhere shorter would change nothing; the length is cc's own socket basename plus the fd number. This is a cc DEFECT and the repair belongs at the caller that chose the basename. Card 2026-0387 owns the mechanism.`, { code: 'FUSE_CONTROL_SOCK_PATH_TOO_LONG' });
  }
  return addr;
}

// TWO REJECTED MECHANISMS, both of which work and both of which are
// disqualified on a PROPERTY rather than on taste. Anyone reaching for more
// room inside the 108-byte budget will find one of them first.
//
//  - `chdir` + a relative bind. cwd is process-global in Node and cc is a
//    concurrent multi-session server, so a second session preparing between the
//    first's `chdir` and its `listen` binds in the WRONG directory.
//  - The abstract namespace (and `/dev/shm`, which fails the same way through
//    the mandatory `/dev` bind mount). An abstract socket is scoped by the
//    NETWORK namespace, and the design unshares only `--mount` — so it would be
//    reachable BY NAME from every process in the chroot with no privilege at
//    all, which is strictly worse than a filesystem socket the tier table can
//    keep out of the union.

// ── the handler ─────────────────────────────────────────────────────────────

const ENOENT = 2, EIO = 5, EACCES = 13, EFBIG = 27;

export interface ControlServerOptions {
  socketPath: string;
  // The per-session mirror directory. A path P from the daemon materialises at
  // `<mirror>/P`, which is exactly what the daemon's remote tier resolves.
  mirror: string;
  source: RemoteSource;
  // THE SAME ARRAY the daemon's pins were rendered from, so cc materialises
  // only what the daemon would serve. It is not a second opinion: the daemon
  // sends a frame ONLY from `route()`'s `T_PROJECT` arm, so a frame naming
  // anything else is a defect, and a CHILD of a project directory that is not
  // itself `project` — an `exclude` renders `fail` — must not be shaped into
  // the mirror at all. Shaping it would put the excluded path's name, size,
  // mode and mtime on this machine and into the parent's listing, which is the
  // metadata the exclusion exists to withhold.
  tiers: readonly TierEntry[];
  log?: (line: string) => void;
}

export class ControlServer {
  #server: net.Server;
  #opts: ControlServerOptions;
  // THE DIRECTORY FD THE SOCKET IS ADDRESSED THROUGH, held for the server's
  // whole life and closed only AFTER `server.close()` resolves.
  //
  // THAT ORDER IS LOAD-BEARING, not tidiness: libuv unlinks the pipe by the
  // NAME IT BOUND WITH, and a closed fd number is reused immediately (measured
  // — the very next open takes it). Closing first would let that unlink land on
  // a `control.sock` inside whatever directory now owns the number. The
  // authoritative unlink is `close()`'s `fsp.rm` on the REAL path.
  #dirfd = -1;
  // SERIALISED PER PATH — the PATH ALONE, and the op is deliberately not in the
  // key. Two FUSE worker threads reaching the same file would otherwise
  // materialise it twice; worse, a `STAT` that did not wait on an in-flight
  // `FETCH` or `DIRTY` would let `#shape` re-truncate the mirror copy to the
  // source's stale size while a writable handle held unpushed bytes, destroying
  // them, and the `DIRTY` would then push the mangled copy.
  #inflight = new Map<string, Promise<Buffer>>();
  // TRACKED EXPLICITLY, because `net.Server` exposes a connection COUNT and not
  // the sockets. `server.close()` stops accepting and then waits for every live
  // connection to end on its own — and the daemon holds one per FUSE worker
  // thread for the life of the mount, so an unclosed set means close() never
  // resolves and both the relaunch and the teardown that call it hang.
  #conns = new Set<net.Socket>();
  // PATHS THIS SESSION CREATED AND HAS NOT PUSHED YET.
  //
  // A file created through the union exists in the MIRROR from the moment of
  // `create` and on the SOURCE only once `release` pushes it. In between, a
  // plain `source.stat` answers "nothing here" for a file the worker is holding
  // open — and libfuse issues a `getattr` immediately after every `create` to
  // build the entry. Without this set that getattr answers -ENOENT, the create
  // fails with the parent reported missing, and #stat's stale-entry removal
  // DELETES the file the worker just wrote. Measured at the real gate (R3).
  //
  // It is a record of what cc itself materialised, which is the only thing that
  // distinguishes "created here, not pushed yet" from "deleted on the source" —
  // the mirror alone cannot tell them apart. Self-healing: an entry whose
  // mirror file has since gone is dropped rather than trusted.
  // THE CLAIM RECORD, and it is the whole of the intent-declaration fix.
  //
  // The mirror is BOTH a cache cc creates, truncates, re-shapes and removes at
  // will AND the statement of what the worker did — two roles in direct
  // conflict, because cc cannot tell its own cache management from the worker's
  // intent. A path is CLAIMED from the `FETCH` that says the caller will mutate
  // it until the `DIRTY` that says what happened, and while claimed cc stops
  // being a cache for it: no `#shape`, no truncate, no `#unmirror`, no re-copy,
  // and no ghost-removal from a parent `LIST`.
  //
  // `createdHere` is the older half (a file that exists in the mirror alone, so
  // an absent source entry is not the source having deleted it) folded into the
  // same record rather than kept as a second one — their lifetimes are
  // identical.
  //
  // WHAT RELEASES A CLAIM, in full, because a claim that outlives its handle is
  // a leak with cc's cache disabled underneath it:
  //   1. the op's own DIRTY, with ONE EXCEPTION that is the whole of §5.2.
  //      A `RELEASE_ONLY` frame releases it OUTRIGHT — that frame IS the
  //      release, so there is no handle left to ask about. A declared removal
  //      (whether the source op succeeded or not), a mirror-holds-nothing
  //      refusal and a SUCCESSFUL push release it once the handle is gone,
  //      i.e. on any DIRTY that does not carry FOR_WRITE.
  //   1a. **A PUSH THAT FAILED DOES NOT.** It KEEPS the claim, on purpose and
  //      permanently for the session: cc must stop managing that path as a
  //      cache, or the next `STAT` or parent `LIST` re-shapes the mirror entry
  //      to the SOURCE's stale size and destroys the only copy of what the
  //      worker wrote. Reads keep serving those bytes — that is the recovery
  //      channel the diverged refusal points at — and writes are refused by
  //      `#fetch`'s fault gate. `#dirty` returns before the release below, and
  //      `tests/fuse-transport.test.mjs` T12 pins all four halves. Do not
  //      "tidy" this into releasing on failure: that re-arms the byte
  //      destruction the claim exists to prevent.
  //   2. `abandon_claim` in the daemon, for an op that took a claim and then
  //      failed before mutating — otherwise no DIRTY would ever arrive. It is
  //      SUBORDINATE to item 1 rather than independent of it: the abandon
  //      produces a DIRTY, and that DIRTY's own outcome decides. It carries
  //      `CCU_FLAG_RELEASE_ONLY` precisely so it lands in item 1's
  //      release-outright case and can never reach 1a — a bare zero was
  //      indistinguishable from a killed handle's release, so an abandon whose
  //      push failed used to keep the claim and poison a file the worker never
  //      wrote (`policy_abandon_claim`, `policy.h`; T13c).
  //   3. this server being dropped. `FuseSession.teardown()` closes it, sets
  //      `#control = null`, and `runTeardown` then `rm -rf`s the run directory
  //      including the mirror, so the map and the files it protects die
  //      together. No claim survives a session.
  #claimed = new Map<string, { createdHere: boolean }>();

  // THE REVALIDATE FINGERPRINT: what the SOURCE held at `p` the last time cc
  // materialised it, plus the identity of the MIRROR entry that is carrying it.
  // `#fetchBody` copies only when this does not match.
  //
  // THE MIRROR INODE IS WHAT MAKES IT SOUND, not what makes it fast. Source
  // size and mtime alone would let cc skip a copy for a mirror entry it is no
  // longer the author of — one re-shaped under it, or replaced by a rename —
  // and serve whatever now sits at that path as though it were fresh. The inode
  // changes in every one of those cases and in none of the safe ones.
  //
  // WHAT IT RESTS ON, recorded rather than assumed: millisecond mtime. The
  // wire's `find -printf '%T@'` is seconds.nanoseconds on GNU, so no precision
  // is lost at the source. A SOURCE WHOSE `stat` COLLAPSES SUB-SECOND
  // PRECISION MUST BE REFUSED before this check is trusted — nothing here
  // enforces that. A source file rewritten within one mtime tick AT AN
  // IDENTICAL SIZE is missed; the window is nanoseconds, and it is named here
  // rather than defended against.
  //
  // Per-session, like the mirror it describes: both die with this server.
  #fresh = new Map<string, { size: number; mtimeMs: number; ino: bigint }>();

  // p → the mode the SOURCE had when cc last looked, and the mirror inode that
  // was carrying it. `#fresh` already holds the inode; this holds the mode.
  //
  // THE DISCRIMINATOR IS THE INODE, and it has to be. A rename over the target
  // REPLACES the mirror entry, so the mode cc is about to push is the tmp
  // file's fresh 0644 and the pre-edit 0755 is gone. A deliberate `chmod` KEEPS
  // the inode, so the mirror's mode is the one the worker asked for and
  // restoring anything would discard it. "Always restore" breaks chmod; "never
  // restore" breaks Edit. The inode separates them with no guessing.
  #mode = new Map<string, { mode: number; ino: bigint }>();

  // A PATH THIS SESSION COULD NOT RECONCILE, OR CANNOT CARRY AT ALL. Sticky for
  // the session's life, and per-session like the mirror it describes: both die
  // with this server.
  //
  // CLEARED BY EXACTLY ONE THING — a SUCCESSFUL push of the same path, which is
  // the moment the diverged sentence becomes false (see `#dirty`). Nothing else
  // clears one, and an `over-cap` fault is cleared by nothing at all. The
  // original rationale for "cleared by nothing" was that cc cannot resync
  // without destroying the bytes the worker wrote — true of every path except
  // that one, where the bytes are what LANDED.
  #faults = new Map<string, Fault>();

  // Set once `close()` starts. A handler that has already been dequeued must
  // not act on a mirror that is about to be removed: teardown deletes the run
  // directory, and a DIRTY running across that would see an absent mirror
  // entry. It cannot mean a deletion any more (that is declared now), but it
  // would still fail the op for the wrong reason, and a LIST would unmirror
  // paths under a directory that is being deleted anyway.
  #closing = false;

  private constructor(server: net.Server, opts: ControlServerOptions) {
    this.#server = server;
    this.#opts = opts;
  }

  static async listen(opts: ControlServerOptions): Promise<ControlServer> {
    // A stale socket from a crashed previous lifecycle would make bind() fail
    // EADDRINUSE even though nothing is listening.
    await fsp.rm(opts.socketPath, { force: true }).catch(() => {});
    const server = net.createServer();
    const self = new ControlServer(server, opts);
    server.on('connection', (sock) => {
      self.#conns.add(sock);
      sock.on('close', () => self.#conns.delete(sock));
      self.#serve(sock);
    });
    // A per-connection error must not take cc down; the daemon reconnects.
    server.on('error', (e) => opts.log?.(`cc-union control: server error: ${String(e)}`));
    // `O_RDONLY|O_DIRECTORY` rather than `O_PATH`: node does not export
    // `fs.constants.O_PATH` (it is `undefined`), and this needs no magic
    // numeric constant to do the same job for an address-only fd.
    self.#dirfd = openSync(path.dirname(opts.socketPath), fsc.O_RDONLY | fsc.O_DIRECTORY);
    try {
      const address = sunPathAddress(self.#dirfd, path.basename(opts.socketPath));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, () => { server.off('error', reject); resolve(); });
      });
    } catch (e) {
      // Or a refused spawn leaks a directory fd per attempt.
      closeSync(self.#dirfd);
      self.#dirfd = -1;
      throw e;
    }
    return self;
  }

  get socketPath(): string { return this.#opts.socketPath; }

  // ── what the hook reads ──────────────────────────────────────────────────
  //
  // The two accessors `SessionRedirect` is wired to. They are READ-ONLY on the
  // record: nothing outside this class sets or clears a fault, so the hook
  // cannot become a second author of the state it reports.

  // The fault standing against `p`, or null. A plain map lookup and no
  // filesystem probe — the mirror is cc's cache and says nothing about whether
  // a reconcile landed.
  faultAt(p: string): Fault | null {
    return this.#faults.get(p) ?? null;
  }

  // Await whatever frame is in flight for `p`, so a caller that reads
  // `faultAt` immediately afterwards reads a SETTLED state rather than a racing
  // one. Never rejects: the frame's own reply carries its outcome, and a
  // handler that threw has already been turned into a REFUSED reply for the
  // daemon — this is the wait, not a second error channel.
  async settle(p: string): Promise<void> {
    await this.#inflight.get(p)?.then(() => {}, () => {});
  }

  // Destroys every live connection FIRST. A daemon blocked on a reply then sees
  // the stream end and turns the op into -EIO at once, which is what lets its
  // threads leave FUSE instead of sitting out the receive timeout.
  // CLOSING IS A DRAIN, NOT A SLAM. Destroying the sockets stops new frames but
  // does NOT stop a handler that has already been dequeued — and teardown's
  // next act is `rm -rf` of the run directory. A DIRTY still running across
  // that would find the mirror gone and fail the op for a reason that has
  // nothing to do with the worker; a LIST would unmirror paths under a
  // directory being deleted anyway. So: refuse anything not yet started, then
  // WAIT for what is in flight before returning to the caller that is about to
  // delete the tree.
  async close(): Promise<void> {
    // ORDER MATTERS, and it is: refuse, DRAIN, then destroy.
    //
    // `#closing` makes every frame not yet started answer REFUSED/EIO at once,
    // so a daemon thread blocked on a reply gets a real errno and leaves FUSE —
    // which is what destroying the sockets first used to achieve, except that
    // it also reset the connection under handlers that were mid-flight, so
    // their replies never reached the worker. Draining before the destroy means
    // an op that was already running is ANSWERED, and the caller that is about
    // to `rm -rf` the run directory waits for it.
    this.#closing = true;
    await Promise.allSettled([...this.#inflight.values()]);
    for (const sock of [...this.#conns]) sock.destroy();
    this.#conns.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    // AFTER close() resolves, never before — see `#dirfd`.
    if (this.#dirfd >= 0) { closeSync(this.#dirfd); this.#dirfd = -1; }
    await fsp.rm(this.#opts.socketPath, { force: true }).catch(() => {});
  }

  #serve(sock: net.Socket): void {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    // Replies must leave in request order even though the handlers are async,
    // so each frame's reply is chained onto the previous one's.
    let tail: Promise<void> = Promise.resolve();
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const decoded = decodeRequests(buf);
      if ('error' in decoded) {
        this.#opts.log?.(`cc-union control: ${decoded.error}; dropping the connection`);
        sock.destroy();
        return;
      }
      buf = decoded.rest;
      for (const req of decoded.frames) {
        tail = tail.then(async () => {
          const reply = await this.#dispatch(req);
          if (!sock.destroyed) sock.write(reply);
        });
      }
    });
  }

  #dispatch(req: ControlRequest): Promise<Buffer> {
    const key = req.path;
    const prior = this.#inflight.get(key);
    const run = (prior ?? Promise.resolve()).then(() => this.#handle(req));
    this.#inflight.set(key, run);
    void run.finally(() => { if (this.#inflight.get(key) === run) this.#inflight.delete(key); });
    return run;
  }

  // `<mirror>/P`, refusing a P that escapes the mirror. The daemon's paths come
  // from the kernel and are already normalised, so this is a belt on a brace —
  // but the mirror is the one directory cc writes on a worker's behalf.
  #mirrorPath(p: string): string | null {
    const abs = path.posix.normalize(path.posix.join(this.#opts.mirror, p));
    return withinPosix(abs, this.#opts.mirror) === null ? null : abs;
  }

  async #handle(req: ControlRequest): Promise<Buffer> {
    // TEARDOWN AUTHORITY. A vanished mirror root means "cc has no authority
    // here" and must never be read as an authoritative answer about the source.
    if (this.#closing) return encodeReply(CCU_STATUS.REFUSED, EIO);
    const dest = this.#mirrorPath(req.path);
    if (dest === null) return encodeReply(CCU_STATUS.REFUSED, EACCES);
    if (!this.#servable(req.path)) {
      this.#opts.log?.(`cc-union control: refusing op ${req.op} for '${req.path}' — not a project-tier path`);
      return encodeReply(CCU_STATUS.REFUSED, EACCES);
    }
    try {
      switch (req.op) {
        case CCU_OP.STAT:  return await this.#stat(req.path, dest);
        case CCU_OP.LIST:  return await this.#list(req.path, dest);
        case CCU_OP.FETCH: return await this.#fetch(req.path, dest, req.forCreate, req.forWrite);
        case CCU_OP.DIRTY: return await this.#dirty(req.path, dest, req.removed, req.forWrite, req.releaseOnly);
        default:
          this.#opts.log?.(`cc-union control: unknown op ${req.op} for '${req.path}'`);
          return encodeReply(CCU_STATUS.REFUSED, EIO);
      }
    } catch (e) {
      this.#opts.log?.(`cc-union control: op ${req.op} '${req.path}': ${String(e)}`);
      return encodeReply(CCU_STATUS.REFUSED, EIO);
    }
  }

  // MIRROR THE METADATA WITHOUT MOVING THE BYTES: an empty file `truncate`d to
  // the source's size is sparse, so a `stat` answers truthfully and a directory
  // listing costs no transfer. The bytes arrive on FETCH.
  async #stat(p: string, dest: string): Promise<Buffer> {
    const st = await this.#opts.source.stat(p);
    // THE SOURCE COULD NOT BE ASKED. Refusing here is what keeps a transient
    // EMFILE from unmirroring a live entry — and, once a writable handle is
    // open on it, from destroying bytes the worker has not pushed.
    if (isSourceError(st)) return this.#sourceFailed('STAT', p, st.error);
    if (st === null) {
      if (await this.#createdHereHolds(p, dest)) return encodeReply(CCU_STATUS.READY, 0);
      // A CLAIMED path the source does not have is the state between a create
      // or an unlink and its reconcile — report it from the mirror rather than
      // removing the entry the worker is holding.
      if (this.#claimHeld(p)) {
        return (await this.#exists(dest))
          ? encodeReply(CCU_STATUS.READY, 0)
          : encodeReply(CCU_STATUS.ABSENT, ENOENT);
      }
      await this.#unmirror(dest);
      return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    if (this.#claimHeld(p)) {
      return (await this.#exists(dest))
        ? encodeReply(CCU_STATUS.READY, 0)
        : encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    await this.#shape(dest, st.kind, st.size, st.mode, st.mtimeMs, st.target);
    return encodeReply(CCU_STATUS.READY, 0);
  }

  async #list(p: string, dest: string): Promise<Buffer> {
    const kids = await this.#opts.source.list(p);
    // A SINGLE FAILED readdir USED TO UNMIRROR THE WHOLE DIRECTORY, and every
    // pending writable release under it then removed its own source file.
    if (isSourceError(kids)) return this.#sourceFailed('LIST', p, kids.error);
    if (kids === null) {
      if (this.#claimHeld(p)) return encodeReply(CCU_STATUS.READY, 0);
      await this.#unmirror(dest);
      return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    await fsp.mkdir(dest, { recursive: true });
    const want = new Set<string>();
    for (const c of kids) {
      const child = path.posix.join(p, c.name);
      // The daemon serves only `project` content from the mirror, so shaping
      // anything else would put a name in the listing the daemon answers about
      // from elsewhere — or, for an excluded prefix, would materialise its very
      // existence and size here. Pinned children are added by the daemon's own
      // readdir, from the same table.
      if (!this.#servable(child)) continue;
      want.add(c.name);
      if (this.#claimHeld(child)) continue;
      await this.#shape(path.posix.join(dest, c.name), c.kind, c.size, c.mode, c.mtimeMs, c.target);
    }
    for (const name of await fsp.readdir(dest).catch(() => [] as string[])) {
      const child = path.posix.join(p, name);
      if (!want.has(name) && !this.#claimHeld(child)) {
        await this.#unmirror(path.posix.join(dest, name));
      }
    }
    return encodeReply(CCU_STATUS.READY, 0);
  }

  // COPIES WHEN THE SOURCE HAS MOVED, and not otherwise. Every open used to
  // transfer the whole file: `#shape` could skip re-truncating a stub whose
  // size and ms-floored mtime matched, but the copy after it ran regardless.
  // Against a local directory that is a `copyFile`; across a wire it is the
  // whole file, per open, for the life of the session.
  //
  // WHAT THAT DOES NOT COVER, stated here because the sentence used to claim
  // more: it is freshness against the SOURCE, not isolation from this session.
  // A CLAIMED path is skipped entirely — a second handle on a path a writer is
  // mid-write on shares the mirror inode and sees the in-progress bytes, which
  // is ordinary POSIX and a deliberate, narrow consequence of the claim.
  //
  // `forCreate` means the caller is about to create the path, so the PARENT is
  // what has to exist. `forWrite` means the caller will mutate it, so cc stops
  // being a cache for it until the matching DIRTY.
  //
  // A CLAIM SURVIVES ONLY A `READY`, AND THAT IS ENFORCED HERE RATHER THAN ON
  // EVERY FAILURE PATH. The first cut recorded the claim before any outcome was
  // known and released it on none of its failures, so any op whose own FETCH
  // failed left one behind — and a leaked claim is worse than a disabled cache:
  // STAT answers ABSENT from it, LIST skips shaping the child, a read-only
  // open short-circuits READY and then fails ENOENT, and a read sends no DIRTY,
  // so nothing ever releases it. A file the source gained later became
  // invisible for the rest of the session. One wrapper, so a failure path
  // added later cannot forget.
  async #fetch(p: string, dest: string, forCreate: boolean, forWrite: boolean): Promise<Buffer> {
    // THE FAULT GATE, AHEAD OF THE CLAIM SHORT-CIRCUIT AND OF EVERY SOURCE
    // CALL. A diverged path refuses a WRITE open and lets a READ through — the
    // read is served from the claim below, out of the mirror, and those
    // preserved bytes are the recovery channel the refusal names. An over-cap
    // path refuses both, because cc never materialised it and has nothing to
    // serve.
    const fault = this.#faults.get(p);
    if (fault !== undefined && (fault.refuses === 'all' || forWrite)) {
      this.#opts.log?.(`cc-union control: FETCH '${p}' refused: ${fault.kind}`);
      return encodeReply(CCU_STATUS.REFUSED, fault.kind === 'over-cap' ? EFBIG : EIO);
    }
    if (this.#claimHeld(p)) return encodeReply(CCU_STATUS.READY, 0);
    let reply: Buffer;
    try {
      reply = await this.#fetchBody(p, dest, forCreate, forWrite);
    } catch (e) {
      this.#claimed.delete(p);
      throw e;
    }
    if (reply[4] !== CCU_STATUS.READY) this.#claimed.delete(p);
    return reply;
  }

  async #fetchBody(p: string, dest: string, forCreate: boolean, forWrite: boolean): Promise<Buffer> {
    // AN ALREADY-CLAIMED PATH IS NOT RE-MATERIALISED — that is the second
    // handle copying over the first's unpushed bytes. But the FETCH that TAKES
    // the claim must still materialise: a worker opening an existing file for
    // write needs its current contents. So the check reads the state BEFORE
    // this frame's own claim is recorded — which `#fetch` above has already
    // checked, before taking one.
    if (forWrite) this.#claimed.set(p, { createdHere: false });
    if (forCreate) {
      const parent = await this.#opts.source.stat(path.posix.dirname(p));
      if (isSourceError(parent)) return this.#sourceFailed('FETCH', p, parent.error);
      if (parent === null) return encodeReply(CCU_STATUS.ABSENT, ENOENT);
      await fsp.mkdir(path.posix.dirname(dest), { recursive: true });
      // The path itself may legitimately not exist yet; an absent source entry
      // is not a refusal here, the create will make it — and cc records that it
      // is about to exist in the mirror alone.
      const self = await this.#opts.source.stat(p);
      if (isSourceError(self)) return this.#sourceFailed('FETCH', p, self.error);
      if (self === null) { this.#claimed.set(p, { createdHere: true }); return encodeReply(CCU_STATUS.READY, 0); }
    }
    const st = await this.#opts.source.stat(p);
    if (isSourceError(st)) return this.#sourceFailed('FETCH', p, st.error);
    if (st === null) {
      if (await this.#createdHereHolds(p, dest)) return encodeReply(CCU_STATUS.READY, 0);
      await this.#unmirror(dest);
      return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    // THE ORDER IS THE POLICY: stat → shape → cap → freshness → copy. `#shape`
    // already leaves alone a file whose size and ms-mtime match, so it and the
    // freshness check agree — but putting freshness FIRST would skip a `#shape`
    // that a kind change needs.
    await this.#shape(dest, st.kind, st.size, st.mode, st.mtimeMs, st.target);
    if (st.kind !== 'file') return encodeReply(CCU_STATUS.READY, 0);
    // THE PROVIDER'S OWN CAP, CHECKED BEFORE THE TRANSFER IS ATTEMPTED — and
    // that saving is real rather than cosmetic. `readFileBytes` also refuses
    // EFBIG, but LATE: `#read`'s fence counts what cc KEEPS, so the provider
    // streams `data` frames until cc's accumulation crosses the cap and only
    // then does cc send `close`. Up to 32 MiB of base64 crosses the wire to be
    // discarded. The size is already in hand from the stat above, so cc
    // refuses having moved nothing.
    if (st.size > MAX_FILE_BYTES) {
      this.#opts.log?.(`cc-union control: FETCH '${p}' refused: ${st.size} bytes exceeds the `
        + `${MAX_FILE_BYTES}-byte protocol cap, so cc cannot materialise it`);
      // RECORDED, so the FILE TOOL can be refused by name before the worker
      // opens the path at all. Without the record the only channel is the
      // daemon's EFBIG, which reaches the model as a bare errno.
      this.#faults.set(p, { kind: 'over-cap', size: st.size, cap: MAX_FILE_BYTES, refuses: 'all' });
      return encodeReply(CCU_STATUS.REFUSED, EFBIG);
    }
    if (await this.#stillFresh(p, dest, st)) return encodeReply(CCU_STATUS.READY, 0);
    const got = await this.#opts.source.fetch(p, dest);
    if (got === 'absent') return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    if (got === 'refused') return encodeReply(CCU_STATUS.REFUSED, EACCES);
    await fsp.chmod(dest, st.mode).catch(() => {});
    await this.#record(p, dest, st);
    return encodeReply(CCU_STATUS.READY, 0);
  }

  // 1 = the mirror entry at `dest` is the one cc put there for exactly these
  // source bytes, so re-copying them would move a file to no effect.
  //
  // ONE LOCAL `lstat` — no source call, which is the whole saving. `bigint:true`
  // because an inode number can exceed 2^53 on a large filesystem and a Number
  // comparison would then answer "same" for two different files.
  async #stillFresh(p: string, dest: string, st: { size: number; mtimeMs: number }): Promise<boolean> {
    const seen = this.#fresh.get(p);
    if (!seen || seen.size !== st.size || seen.mtimeMs !== st.mtimeMs) return false;
    try {
      const cur = await fsp.lstat(dest, { bigint: true });
      return cur.ino === seen.ino;
    } catch { return false; }
  }

  async #record(p: string, dest: string, st: { size: number; mtimeMs: number; mode: number }): Promise<void> {
    try {
      const cur = await fsp.lstat(dest, { bigint: true });
      this.#fresh.set(p, { size: st.size, mtimeMs: st.mtimeMs, ino: cur.ino });
      // THE MODE LEDGER IS WRITTEN HERE, IN ONE CALL WITH THE FINGERPRINT, and
      // that is the invariant — not that the two values come from one
      // observation, because they do not: the mode is the SOURCE's (`st.mode`)
      // and the inode is the MIRROR entry's (`cur.ino`). What matters is that
      // they are recorded TOGETHER, so the pair can never be half-updated and
      // the inode a mode is compared against is always the entry that was
      // carrying that mode.
      this.#mode.set(p, { mode: st.mode, ino: cur.ino });
    } catch {
      // A mirror entry that has already gone is not a fingerprint worth
      // keeping: the next FETCH must copy, which is what NOT recording means.
      this.#fresh.delete(p);
      this.#mode.delete(p);
    }
  }

  // READY MEANS CC HAS TAKEN OWNERSHIP OF THE PUSH, NOT THAT THE PUSH LANDED
  // — the awaiting half is 2026-0356's. What READY does mean here is that the
  // copy completed, so a failure is still reported rather than swallowed, and
  // the daemon answers it to the worker's `close(2)` through `flush`.
  //
  // `removed` IS THE INTENT, DECLARED. An absent mirror entry is never read as
  // a deletion: it is either an op that already reconciled the path (the claim
  // is gone, so there is nothing owed) or cc's own cache having lost something
  // it was holding for a worker — which refuses rather than deleting.
  //
  // `stillOpen` (FOR_WRITE on a DIRTY) means the handle has not closed, so the
  // claim is KEPT: `flush` fires per `close` of a duplicated descriptor while
  // the original stays open, and releasing there left the next write batch on
  // that handle unprotected. `release` sends it clear, and is the only releaser.
  async #dirty(p: string, dest: string, removed: boolean, stillOpen = false,
               releaseOnly = false): Promise<Buffer> {
    // RELEASE_ONLY, AND IT IS ANSWERED BEFORE ANY SOURCE CALL. The handle is
    // closing and its `flush` already landed the bytes, so the releasing frame
    // has nothing left to carry — without this every written file uploaded
    // twice. It DOES NOT CLEAR A FAULT, and the two directions are consistent:
    // a diverged `flush` returned non-zero, so the daemon's `fd_dirty` is
    // still set and `release` sends a FULL reconcile, which fails again and
    // leaves the fault standing.
    if (releaseOnly) {
      this.#claimed.delete(p);
      return encodeReply(CCU_STATUS.READY, 0);
    }
    const claimed = this.#claimed.has(p);
    let r: 'ok' | { error: string };
    if (removed) {
      r = await this.#opts.source.remove(p);
    } else if (!(await this.#exists(dest))) {
      if (!claimed) { this.#claimed.delete(p); return encodeReply(CCU_STATUS.READY, 0); }
      r = { error: `the mirror holds nothing at '${p}', and this session claimed it` };
    } else {
      await this.#restoreMode(p, dest);
      r = await this.#opts.source.push(dest, p);
      if (r !== 'ok') {
        // A FAILED PUSH IS LOUD AND STICKY, AND THE CLAIM IS KEPT — which is
        // what makes the worker's unpushed bytes survive. Dropping the claim
        // here would put cc back in charge of the path as a cache, and the
        // next `STAT` or parent `LIST` would re-shape the mirror entry to the
        // SOURCE's stale size, destroying the only copy of what the worker
        // wrote. Reads keep working and serve those bytes; writes are refused
        // by the fault gate in `#fetch`.
        //
        // RECORDED ON THE PUSH BRANCH ONLY, and that is not an oversight: the
        // refusal's wording promises the local copy is intact and readable,
        // which is true exactly here. A failed `remove`, and a claimed path
        // whose mirror entry has vanished under cc, cannot honour that
        // sentence and are released as before.
        this.#faults.set(p, { kind: 'diverged', detail: r.error, refuses: 'writes' });
        this.#opts.log?.(`cc-union control: DIRTY '${p}' failed: ${r.error}`);
        return encodeReply(CCU_STATUS.REFUSED, EIO);
      }
      // AND A SUCCESSFUL PUSH OF THIS PATH CLEARS A DIVERGENCE OF THIS PATH,
      // because at that moment the sentence the fault produces is FALSE: the
      // system's copy now holds the mirror's bytes.
      //
      // IT IS REACHED BY THE DAEMON'S OWN SEQUENCE, not by a contrivance. A
      // `flush` that refuses records the fault and returns non-zero, so
      // `fd_dirty` stays set and the `release` sends a FULL reconcile — and if
      // whatever blocked the push has gone in between, that one lands. Without
      // this clear, every later write open of a repaired path is refused for
      // the rest of the session by a sentence asserting a divergence that no
      // longer exists.
      //
      // NARROW BY CONSTRUCTION, and deliberately: only a `diverged` fault, only
      // on the branch that records one, only for the path that was pushed. A
      // path whose pushes keep failing stays sticky, which is the whole of
      // §5.2. An `over-cap` fault is never cleared here either: it is not a
      // divergence but a statement that cc cannot carry the file at all, and
      // landing a push says nothing about that.
      if (this.#faults.get(p)?.kind === 'diverged') this.#faults.delete(p);
      await this.#adoptWriteMtime(p, dest);
    }
    // RELEASED once the handle is gone — for every branch that REACHES here.
    // A push that failed does NOT: it returned above, keeping the claim for the
    // session (§5.2, and see `#claimed`'s item 1a). What is left is a declared
    // removal, whose source op may have succeeded or failed, and a successful
    // push. For those the reconcile has been attempted and answered, so the
    // window the claim protects is over and keeping it would leave cc's cache
    // off for the rest of the session with nothing to protect.
    if (!stillOpen) this.#claimed.delete(p);
    if (r === 'ok') return encodeReply(CCU_STATUS.READY, 0);
    this.#opts.log?.(`cc-union control: DIRTY '${p}' failed: ${r.error}`);
    return encodeReply(CCU_STATUS.REFUSED, EIO);
  }

  // MODE PRESERVATION ACROSS THE WRITE ROUND TRIP. An atomic write ends in a
  // `rename`, and a rename hands the replacement file the TMP file's fresh
  // 0644 — so pushing the mirror entry's own mode would silently strip a
  // 0755 script of its executable bit.
  //
  // CHMOD THE MIRROR, DO NOT PASS A MODE THROUGH `push`. `RemoteSource.push`
  // keeps its signature so both sources behave identically; the invariant
  // `#shape` maintains — the mirror entry's mode is the source's — is RESTORED
  // rather than bypassed; and the property becomes observable on this machine,
  // so a test can assert the mirror as well as the source.
  //
  // A path with no recorded source mode is a file the worker created, and it
  // pushes the mirror's own mode. Correct.
  async #restoreMode(p: string, dest: string): Promise<void> {
    const rec = this.#mode.get(p);
    if (rec === undefined) return;
    let cur: import('node:fs').BigIntStats;
    try { cur = await fsp.lstat(dest, { bigint: true }); } catch { return; }
    // A REGULAR FILE OR NOTHING, and the test is not defensive: `chmod` FOLLOWS
    // a symlink, so a mirror entry that is now a LINK at a path cc recorded a
    // file mode against would land that mode on the link's TARGET — another
    // file in the mirror, whose own recorded mode then disagrees with its entry
    // and whose next push carries the wrong one. A kind change is not a mode
    // change and there is nothing here to preserve.
    if (!cur.isFile()) return;
    // SAME INODE ⇒ THE WORKER'S OWN CHMOD, and restoring would discard it.
    if (cur.ino === rec.ino) return;
    await fsp.chmod(dest, rec.mode).catch(() => {});
  }

  // ONE ROUND TRIP ON THE WRITE PATH THAT SAVES A WHOLE DOWNLOAD ON THE NEXT
  // READ. `push` is an atomic write, so the source entry comes out with a
  // FRESH mtime that cc's fingerprint has never seen — and the following open
  // would re-download the file the worker just wrote. cc re-stats the source,
  // stamps the mirror entry with the mtime the source now carries, and records
  // the pair.
  //
  // The mirror is stamped rather than the source: setting the SOURCE's mtime to
  // the mirror's would misreport when the source changed, which build tools on
  // that machine depend on.
  async #adoptWriteMtime(p: string, dest: string): Promise<void> {
    // THE KIND TEST IS LOCAL, so a directory or symlink reconcile pays NOTHING
    // for a fingerprint only a file has. Asking the source would have cost a
    // round trip per directory mutation to learn what the mirror entry already
    // says.
    let cur: import('node:fs').Stats;
    try { cur = await fsp.lstat(dest); } catch { this.#fresh.delete(p); return; }
    if (!cur.isFile()) return;
    const st = await this.#opts.source.stat(p);
    if (isSourceError(st) || st === null || st.kind !== 'file') { this.#fresh.delete(p); return; }
    // THE SOURCE MUST STILL HOLD WHAT CC PUSHED, and this is the ONE place in
    // this file that needs saying so. Every other writer of a `#fresh`
    // fingerprint stats the source BEFORE copying its bytes, so a source change
    // during the copy leaves the fingerprint stale and the next FETCH
    // conservatively re-copies. THIS ONE STATS AFTER, with no copy in between,
    // which inverts that: a box-side writer landing between the push and this
    // stat would have cc pair the MIRROR's bytes with the OTHER writer's
    // `(size, mtime)`, and the next open would then match size, mtime AND the
    // mirror inode — which the push never touched, so the inode half cannot
    // help here — skip the copy, and serve the worker its own bytes as the
    // file's content. Acceptance criterion 9 puts two workers on one remote
    // project, so that population is real.
    //
    // NOT RECORDING IS ALWAYS SAFE: the next FETCH copies, which is the
    // behaviour before any adoption existed.
    //
    // WHAT THE SIZE TEST DOES NOT COVER, named beside the identical-size limit
    // `#fresh` already carries: a racing write of the SAME LENGTH. cc has no
    // cheaper evidence — `RemoteStat` carries no source inode, and the
    // derivation `find -printf` cannot supply one — and a content read would be
    // the whole download this saving exists to avoid.
    if (st.size !== cur.size) { this.#fresh.delete(p); return; }
    await fsp.utimes(dest, new Date(st.mtimeMs), new Date(st.mtimeMs)).catch(() => {});
    await this.#record(p, dest, st);
  }

  async #exists(dest: string): Promise<boolean> {
    try { await fsp.lstat(dest); return true; } catch { return false; }
  }

  #sourceFailed(op: string, p: string, err: string): Buffer {
    this.#opts.log?.(`cc-union control: ${op} '${p}' could not reach the source: ${err}`);
    return encodeReply(CCU_STATUS.REFUSED, EIO);
  }

  // 1 = the daemon would serve this path from the mirror, i.e. it is
  // `project`-tier in the ONE table the pins were rendered from.
  #servable(p: string): boolean {
    return resolveTierEntry(this.#opts.tiers, p)?.tier === 'project';
  }

  // 1 = the worker holds a claim, so cc must not manage this path as a cache.
  // A PLAIN MAP LOOKUP, with no filesystem probe: the whole point of the claim
  // is that mirror state stops being evidence about intent while it is held,
  // so consulting the mirror to decide whether the claim is live would put the
  // inference straight back. A claimed path whose mirror entry is absent is the
  // ordinary state between an `unlink` and its `DIRTY`.
  #claimHeld(p: string): boolean {
    return this.#claimed.has(p);
  }

  // 1 = the mirror is holding something this session CREATED and has not
  // pushed, so an absent SOURCE entry is not the source having deleted it.
  // This one does probe, and must: it is answering "is there anything here",
  // not "may cc manage it". A created-then-unlinked path drops the record.
  async #createdHereHolds(p: string, dest: string): Promise<boolean> {
    if (!this.#claimed.get(p)?.createdHere) return false;
    try { await fsp.lstat(dest); return true; }
    catch { this.#claimed.delete(p); return false; }
  }

  // Make `<mirror>/P` be of `kind`, with the source's mode, size and mtime. A
  // mirror entry of the WRONG kind is replaced, not adjusted: a directory that
  // became a file on the source cannot be chmod'd into one.
  async #shape(dest: string, kind: 'file' | 'dir' | 'symlink', size: number, mode: number, mtimeMs: number, target?: string): Promise<void> {
    await fsp.mkdir(path.posix.dirname(dest), { recursive: true });
    let cur: import('node:fs').Stats | null = null;
    try { cur = await fsp.lstat(dest); } catch { /* absent */ }
    const kindOf = (s: import('node:fs').Stats): string => s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file';
    if (cur && kindOf(cur) !== kind) { await this.#unmirror(dest); cur = null; }

    if (kind === 'symlink') {
      if (cur && await fsp.readlink(dest).catch(() => null) === target) return;
      await this.#unmirror(dest);
      await fsp.symlink(target ?? '', dest);
      return;
    }
    if (kind === 'dir') {
      if (!cur) await fsp.mkdir(dest, { recursive: true });
      await fsp.chmod(dest, mode).catch(() => {});
      return;
    }
    // A file already the right size and mtime is left ALONE — re-truncating it
    // would discard bytes an earlier FETCH put there, and every read is
    // preceded by an open and therefore by a FETCH, so the only thing that
    // would achieve is throwing work away.
    if (cur && cur.size === size && Math.floor(cur.mtimeMs) === Math.floor(mtimeMs)) return;
    const fh = await fsp.open(dest, fsc.O_CREAT | fsc.O_WRONLY, mode);
    try { await fh.truncate(size); } finally { await fh.close(); }
    await fsp.chmod(dest, mode).catch(() => {});
    await fsp.utimes(dest, new Date(mtimeMs), new Date(mtimeMs)).catch(() => {});
  }

  async #unmirror(dest: string): Promise<void> {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
  }
}
