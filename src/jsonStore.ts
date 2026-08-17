// Shared sidecar-JSON-store helper.
//
// The `<store>/*.json` session sidecars (titles, summaries, conducted, temp,
// backends, archived) are all the same machine: read the whole document,
// mutate it in memory, write it back atomically. That read-modify-write is the
// part that is easy to get subtly wrong, and it was previously copy-pasted six
// times — which is how two of the six ended up WITHOUT the cross-process lock
// the other four were hardened with.
//
// This factory owns the whole chain, in this order:
//
//   mutate(fn) = serialize( withLock( fn(loadStrict()) ) )
//
//   1. serialize — a per-process promise chain. This is a CONTENTION guard, not
//      the correctness guard: `withLock` is O_EXCL and treats a second caller in
//      this same process like any other live owner, so it already excludes them.
//      But that second caller then burns bounded acquire retries waiting, and a
//      burst wide enough to exhaust them throws instead of writing. The chain
//      keeps same-process writers off the lockfile entirely.
//   2. withLock — the O_EXCL cross-process advisory lock (storeLock.ts). THIS is
//      the correctness guard. The contended window is a hot restart, where the
//      exiting old server and the booting new one both write; without it they
//      lose each other's updates.
//   3. loadStrict — a canonical re-read INSIDE the lock. Anything read before
//      acquiring it is already stale.
//
// Reads come in two flavours, and the difference is load-bearing:
//   - load()       lenient. ENOENT or any read/parse failure yields the empty
//                  value with a warning. Used by the query surface, where
//                  degrading to "nothing recorded" beats throwing at a caller
//                  that just wants to render a list.
//   - loadStrict() ENOENT yields empty (legitimately unwritten), but every
//                  other failure THROWS. Used inside mutations so a transient
//                  read error can never be laundered into "the store was empty"
//                  and then written back as truth.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withLock } from './storeLock.ts';

export interface JsonStoreConfig<T> {
  // Absolute path of the store file. Lazy so PROJECTS_ROOT overrides in tests
  // are honoured per call rather than frozen at module load.
  file: () => string;
  // Label used in warning messages (e.g. 'sessionTitles').
  noun: string;
  // The empty value — a fresh Set/Map per call, never a shared instance.
  empty: () => T;
  // JSON.parse output → the in-memory value. This is the untyped on-disk
  // boundary, so implementations validate rather than trust.
  parse: (raw: unknown) => T;
  // In-memory value → the document to persist.
  toDoc: (value: T) => unknown;
  isEmpty: (value: T) => boolean;
  // When true (default) a write of an empty value UNLINKS the file instead of
  // persisting an empty document. archivedSessions opts out: it always writes an
  // explicit `{"sessions":[]}` so that an absent primary unambiguously means
  // external loss rather than a legitimate drain-to-empty.
  unlinkWhenEmpty?: boolean;
  // Optional recovery layers. Only archivedSessions supplies these, for its
  // rolling `.bak`: `loadLenient`/`loadStrict` replace the default readers
  // outright, and `afterWrite` runs inside the lock right after the rename.
  loadLenient?: () => Promise<T>;
  loadStrict?: () => Promise<T>;
  afterWrite?: (value: T, json: string) => Promise<void>;
}

// Deliberately NARROW: `load` (lenient, for the query surface) and `mutate`.
// `loadStrict` and `write` stay INTERNAL — `mutate` is the only way to reach
// them. Exposing a bare `write()` would be a public UNLOCKED write on the very
// primitive that exists to guarantee the lock, i.e. a one-call reintroduction
// of the lost update this module was written to close.
export interface JsonStore<T> {
  load(): Promise<T>;
  // serialize + lock + strict re-read. `fn` receives the canonical value and
  // calls `write` itself when it actually changed something (so a no-op
  // mutation costs no write).
  mutate<R>(fn: (value: T, write: (value: T) => Promise<void>) => Promise<R>): Promise<R>;
}

export function createJsonStore<T>(config: JsonStoreConfig<T>): JsonStore<T> {
  const { file, noun, empty, parse, toDoc, isEmpty, unlinkWhenEmpty = true } = config;

  async function defaultLoadLenient(): Promise<T> {
    try {
      return parse(JSON.parse(await fs.readFile(file(), 'utf8')));
    } catch (e) {
      if (errCode(e) === 'ENOENT') return empty();
      console.warn(`${noun}: failed to read ${file()}: ${errMsg(e)}`);
      return empty();
    }
  }

  async function defaultLoadStrict(): Promise<T> {
    try {
      return parse(JSON.parse(await fs.readFile(file(), 'utf8'))); // SyntaxError on corrupt JSON
    } catch (e) {
      if (errCode(e) === 'ENOENT') return empty(); // legitimately empty
      throw e; // I/O error or corrupt JSON — abort the mutation
    }
  }

  const load = config.loadLenient ?? defaultLoadLenient;
  const loadStrict = config.loadStrict ?? defaultLoadStrict;

  async function write(value: T): Promise<void> {
    const target = file();
    if (unlinkWhenEmpty && isEmpty(value)) {
      try { await fs.unlink(target); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const json = JSON.stringify(toDoc(value), null, 2) + '\n';
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, json);
    await fs.rename(tmp, target);
    if (config.afterWrite) await config.afterWrite(value, json);
  }

  // Per-process write chain. `.then(fn, fn)` runs the next mutation whether the
  // previous settled or rejected, so one failure cannot wedge the store; the
  // `.catch` keeps the retained chain from becoming an unhandled rejection while
  // still handing the real rejection back to this caller.
  let writeChain: Promise<unknown> = Promise.resolve();
  function serialize<R>(fn: () => Promise<R>): Promise<R> {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  }

  function mutate<R>(fn: (value: T, w: (value: T) => Promise<void>) => Promise<R>): Promise<R> {
    return serialize(() => withLock(file(), async () => fn(await loadStrict(), write)));
  }

  return { load, mutate };
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict).
export function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
