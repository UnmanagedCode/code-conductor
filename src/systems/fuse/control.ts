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
import type { RemoteSource } from './remoteSource.ts';

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
export const CCU_FLAG_FOR_CREATE = 0x01;

export interface ControlRequest {
  op: number;
  forCreate: boolean;
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

const ENOENT = 2, EIO = 5, EACCES = 13;

export interface ControlServerOptions {
  socketPath: string;
  // The per-session mirror directory. A path P from the daemon materialises at
  // `<mirror>/P`, which is exactly what the daemon's remote tier resolves.
  mirror: string;
  source: RemoteSource;
  log?: (line: string) => void;
}

export class ControlServer {
  #server: net.Server;
  #opts: ControlServerOptions;
  // SERIALISED PER PATH: two FUSE worker threads reaching the same file would
  // otherwise materialise it twice, and the second copy would land on top of a
  // handle the first already handed out.
  #inflight = new Map<string, Promise<Buffer>>();
  // TRACKED EXPLICITLY, because `net.Server` exposes a connection COUNT and not
  // the sockets. `server.close()` stops accepting and then waits for every live
  // connection to end on its own — and the daemon holds one per FUSE worker
  // thread for the life of the mount, so an unclosed set means close() never
  // resolves and both the relaunch and the teardown that call it hang.
  #conns = new Set<net.Socket>();

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
  async close(): Promise<void> {
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
    const key = `${req.op}\0${req.path}`;
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
    const dest = this.#mirrorPath(req.path);
    if (dest === null) return encodeReply(CCU_STATUS.REFUSED, EACCES);
    try {
      switch (req.op) {
        case CCU_OP.STAT:  return await this.#stat(req.path, dest);
        case CCU_OP.LIST:  return await this.#list(req.path, dest);
        case CCU_OP.FETCH: return await this.#fetch(req.path, dest, req.forCreate);
        case CCU_OP.DIRTY: return await this.#dirty(req.path, dest);
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
    if (st === null) {
      await this.#unmirror(dest);
      return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    await this.#shape(dest, st.kind, st.size, st.mode, st.mtimeMs, st.target);
    return encodeReply(CCU_STATUS.READY, 0);
  }

  async #list(p: string, dest: string): Promise<Buffer> {
    const children = await this.#opts.source.list(p);
    if (children === null) {
      await this.#unmirror(dest);
      return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    await fsp.mkdir(dest, { recursive: true });
    const want = new Set(children.map(c => c.name));
    for (const c of children) {
      await this.#shape(path.posix.join(dest, c.name), c.kind, c.size, c.mode, c.mtimeMs, c.target);
    }
    // REMOVE WHAT THE SOURCE NO LONGER HAS, or readdir shows ghosts: a file
    // deleted on the remote would keep appearing until the session ended.
    for (const name of await fsp.readdir(dest)) {
      if (!want.has(name)) await this.#unmirror(path.posix.join(dest, name));
    }
    return encodeReply(CCU_STATUS.READY, 0);
  }

  // ALWAYS COPIES, with no revalidation shortcut, so freshness at open is
  // exact. `forCreate` means the caller is about to create the path, so the
  // PARENT is what has to exist.
  async #fetch(p: string, dest: string, forCreate: boolean): Promise<Buffer> {
    if (forCreate) {
      const parent = await this.#opts.source.stat(path.posix.dirname(p));
      if (parent === null) return encodeReply(CCU_STATUS.ABSENT, ENOENT);
      await fsp.mkdir(path.posix.dirname(dest), { recursive: true });
      // The path itself may legitimately not exist yet; an absent source entry
      // is not a refusal here, the create will make it.
      const self = await this.#opts.source.stat(p);
      if (self === null) return encodeReply(CCU_STATUS.READY, 0);
    }
    const st = await this.#opts.source.stat(p);
    if (st === null) {
      await this.#unmirror(dest);
      return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    }
    await this.#shape(dest, st.kind, st.size, st.mode, st.mtimeMs, st.target);
    if (st.kind !== 'file') return encodeReply(CCU_STATUS.READY, 0);
    const got = await this.#opts.source.fetch(p, dest);
    if (got === 'absent') return encodeReply(CCU_STATUS.ABSENT, ENOENT);
    if (got === 'refused') return encodeReply(CCU_STATUS.REFUSED, EACCES);
    await fsp.chmod(dest, st.mode).catch(() => {});
    return encodeReply(CCU_STATUS.READY, 0);
  }

  // READY MEANS CC HAS TAKEN OWNERSHIP OF THE PUSH, NOT THAT THE PUSH LANDED
  // — the awaiting half is 2026-0356's. What READY does mean here is that the
  // copy completed, so a failure is still reported rather than swallowed.
  async #dirty(p: string, dest: string): Promise<Buffer> {
    const r = await this.#opts.source.push(dest, p);
    if (r === 'ok') return encodeReply(CCU_STATUS.READY, 0);
    this.#opts.log?.(`cc-union control: DIRTY '${p}' failed: ${r.error}`);
    return encodeReply(CCU_STATUS.REFUSED, EIO);
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
