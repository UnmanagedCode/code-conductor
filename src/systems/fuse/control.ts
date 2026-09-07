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
// mount root and is tiered `hide`, so nothing inside the chroot can name it —
// containment is structural rather than policy.

import net from 'node:net';
import path from 'node:path';
import { promises as fsp, constants as fsc } from 'node:fs';
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

export interface ControlRequest {
  op: number;
  forCreate: boolean;
  forWrite: boolean;
  removed: boolean;
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
  //   1. the op's own DIRTY, whether it succeeds or fails. Once the reconcile
  //      has been ATTEMPTED and answered, the window is over and the worker has
  //      the outcome; holding the claim past that is the sticky behaviour that
  //      is deliberately 2026-0356's.
  //   2. `abandon_claim` in the daemon, for an op that took a claim and then
  //      failed before mutating — otherwise no DIRTY would ever arrive.
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
  // WHAT IT RESTS ON, recorded rather than assumed: millisecond mtime.
  // `find -printf '%T@'` is seconds.nanoseconds on GNU and `code-system`'s
  // baseline probe already refuses a target whose `stat` drops sub-second
  // precision. A source file rewritten within one mtime tick AT AN IDENTICAL
  // SIZE is missed; the window is nanoseconds, and it is named here rather than
  // defended against.
  //
  // Per-session, like the mirror it describes: both die with this server.
  #fresh = new Map<string, { size: number; mtimeMs: number; ino: bigint }>();

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
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.socketPath, () => { server.off('error', reject); resolve(); });
    });
    return self;
  }

  get socketPath(): string { return this.#opts.socketPath; }

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
        case CCU_OP.DIRTY: return await this.#dirty(req.path, dest, req.removed, req.forWrite);
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
    // THE PROVIDER'S OWN CAP, CHECKED BEFORE A BYTE MOVES. `readFileBytes`
    // would refuse EFBIG having transferred nothing anyway, but the size is
    // already in hand from the stat above, so cc refuses without spending the
    // round trip.
    if (st.size > MAX_FILE_BYTES) {
      this.#opts.log?.(`cc-union control: FETCH '${p}' refused: ${st.size} bytes exceeds the `
        + `${MAX_FILE_BYTES}-byte protocol cap, so cc cannot materialise it`);
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

  async #record(p: string, dest: string, st: { size: number; mtimeMs: number }): Promise<void> {
    try {
      const cur = await fsp.lstat(dest, { bigint: true });
      this.#fresh.set(p, { size: st.size, mtimeMs: st.mtimeMs, ino: cur.ino });
    } catch {
      // A mirror entry that has already gone is not a fingerprint worth
      // keeping: the next FETCH must copy, which is what NOT recording means.
      this.#fresh.delete(p);
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
  async #dirty(p: string, dest: string, removed: boolean, stillOpen = false): Promise<Buffer> {
    const claimed = this.#claimed.has(p);
    let r: 'ok' | { error: string };
    if (removed) {
      r = await this.#opts.source.remove(p);
    } else if (!(await this.#exists(dest))) {
      if (!claimed) { this.#claimed.delete(p); return encodeReply(CCU_STATUS.READY, 0); }
      r = { error: `the mirror holds nothing at '${p}', and this session claimed it` };
    } else {
      r = await this.#opts.source.push(dest, p);
    }
    // RELEASED EITHER WAY once the handle is gone — success or failure. The
    // reconcile has been attempted and answered, so the window the claim
    // protects is over; keeping it would leave cc's cache off for the rest of
    // the session.
    if (!stillOpen) this.#claimed.delete(p);
    if (r === 'ok') return encodeReply(CCU_STATUS.READY, 0);
    this.#opts.log?.(`cc-union control: DIRTY '${p}' failed: ${r.error}`);
    return encodeReply(CCU_STATUS.REFUSED, EIO);
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
