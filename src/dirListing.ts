// SUBDIRECTORY LISTING OF ONE ABSOLUTE PATH ON ONE SYSTEM — the server half of
// the path autocomplete in the Adopt and New-project dialogs (`GET
// /api/fs/dirs`).
//
// ONE RESPONSIBILITY: answer "which subdirectories does this path hold?" for
// `local` and for every registered system alike. It goes through
// `systemById(...)` → `System.readDir`, the same seam `adoptProject` uses to
// probe a tree that is not yet a project, so it is a use of the System seam and
// not an entry on the bare-`fs` exception list.
//
// COST BOUND: one `readDir` plus at most DIR_LIST_MAX_LINK_STATS symlink
// `stat`s IN TOTAL per listing, however many symlinks the directory holds. `readDir` reports a
// symlink as `symlink` without saying what it points at, and `stat` (which
// follows links) is the only System call that answers it. Links past the budget,
// or unanswered when DIR_LIST_LINK_DEADLINE_MS passes, are returned MARKED in
// `links` — offered as candidates, never claimed to be directories.
//
// WHY THE LINK PHASE SITS OUTSIDE THE DIR_LIST_DEADLINE_MS RACE: once `readDir`
// has answered, a slow link must not turn that answer into a refusal.
//
// WHY NO SINGLE-EXEC ALTERNATIVE: nothing on the `System` interface asks "is
// this a directory, following links" for many entries in one round trip, and a
// `find -xtype d` through `exec` would be a second derivation of `readDir`
// living outside `src/systems/` — one that also spawns `find` on LocalSystem,
// which Windows lacks.
//
// WHY ITS OWN DEADLINE: the System layer's DEFAULT_OP_TIMEOUT_MS is a liveness
// fence, not a performance budget, and is far too long for a keystroke-driven
// dropdown. `readDir` takes no AbortSignal, so an operation that misses the
// deadline is left to that fence; its promise is given a no-op catch so it
// cannot surface as an unhandled rejection.
//
// EXPOSURE: no auth, like the rest of the REST surface. It discloses directory
// names anywhere cc's user (or the provider's user) can read — the trust level
// of `adopt_project` / `system_bash`.

import path from 'node:path';
import { systemById, isSystemRefusal } from './systems/registry.ts';
import { LOCAL_SYSTEM_ID } from './systems/localSystem.ts';
import { SystemError } from './systems/protocol.ts';
import type { System, SystemDirent } from './systems/system.ts';
import { validateRemoteId } from './projects.ts';

// Most names returned; `entries` and `links` count together.
export const DIR_LIST_MAX_ENTRIES = 1000;
// Covers `systemById` (the connect) plus `readDir`.
export const DIR_LIST_DEADLINE_MS = 10_000;
// Symlinks resolved per listing, in name order.
export const DIR_LIST_MAX_LINK_STATS = 64;
// `stat`s in flight at once.
export const DIR_LIST_LINK_STAT_BATCH = 16;
// The whole link phase.
export const DIR_LIST_LINK_DEADLINE_MS = 2_000;

export interface DirListOk {
  ok: true;
  system: string;
  remoteId: string | null;
  path: string;
  entries: string[];
  links: string[];
  truncated: boolean;
  max: number;
}
export interface DirListRefusal { ok: false; code: string; reason: string }

// A `stat` failure about ONE entry: it drops that link and says nothing about
// the system. Anything else that settles in time is the system failing.
const PER_ENTRY_CODES = new Set(['EACCES', 'ELOOP', 'ENOTDIR', 'ENAMETOOLONG', 'ENOENT']);

const errCode = (e: unknown): string | null =>
  e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code : null;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const TIMED_OUT = Symbol('timed-out');

export async function selectDirs(
  sys: System,
  dir: string,
  dirents: SystemDirent[],
  { linkDeadlineMs = DIR_LIST_LINK_DEADLINE_MS }: { linkDeadlineMs?: number } = {},
): Promise<{ entries: string[]; links: string[]; truncated: boolean }> {
  const candidates = dirents
    .filter(d => d.kind === 'dir' || d.kind === 'symlink')
    .sort((a, b) => byCodeUnit(a.name, b.name));
  const window = candidates.slice(0, DIR_LIST_MAX_ENTRIES);
  const truncated = candidates.length > DIR_LIST_MAX_ENTRIES;

  const entries = window.filter(d => d.kind === 'dir').map(d => d.name);
  const symlinks = window.filter(d => d.kind === 'symlink').map(d => d.name);
  const toResolve = symlinks.slice(0, DIR_LIST_MAX_LINK_STATS);
  const resolved = new Set<string>();
  const dropped = new Set<string>();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), linkDeadlineMs);
  });
  try {
    for (let i = 0; i < toResolve.length; i += DIR_LIST_LINK_STAT_BATCH) {
      const batch = toResolve.slice(i, i + DIR_LIST_LINK_STAT_BATCH);
      const stats = batch.map(async name => {
        try {
          const st = await sys.stat(path.posix.join(dir, name));
          if (st && st.kind === 'dir') resolved.add(name); else dropped.add(name);
        } catch (e) {
          const code = errCode(e);
          if (code && PER_ENTRY_CODES.has(code)) { dropped.add(name); return; }
          throw e;
        }
      });
      // An in-flight stat that loses the race must not become an unhandled
      // rejection; a late answer is ignored.
      const all = Promise.all(stats);
      all.catch(() => {});
      const outcome = await Promise.race([all, deadline]);
      if (outcome === TIMED_OUT) break;
    }
  } finally {
    clearTimeout(timer);
  }

  const settled = new Set([...resolved, ...dropped]);
  const links: string[] = [];
  for (const name of symlinks) {
    if (resolved.has(name)) entries.push(name);
    else if (!settled.has(name)) links.push(name);
  }
  entries.sort(byCodeUnit);
  links.sort(byCodeUnit);
  return { entries, links, truncated };
}

export async function listDirectories(
  q: { system?: unknown; remoteId?: unknown; path?: unknown },
  { deadlineMs = DIR_LIST_DEADLINE_MS, linkDeadlineMs, resolveSystem = systemById }: {
    deadlineMs?: number;
    linkDeadlineMs?: number;
    // The seam the unit tests hand a fake System through; production uses the registry.
    resolveSystem?: typeof systemById;
  } = {},
): Promise<DirListOk | DirListRefusal> {
  const refuse = (code: string, reason: string): DirListRefusal => ({ ok: false, code, reason });
  const p = q.path;
  if (typeof p !== 'string' || p === '' || !path.isAbsolute(p)) {
    return refuse('INVALID_PATH', 'path must be a non-empty absolute path.');
  }
  if (q.system !== undefined && typeof q.system !== 'string') {
    return refuse('INVALID_PATH', 'system must be a string.');
  }
  const system = (q.system ?? '').trim() || LOCAL_SYSTEM_ID;
  let remoteId: string | null;
  try { remoteId = validateRemoteId(q.remoteId); }
  catch (e) { return refuse('INVALID_REMOTE_ID', (e as Error).message); }
  if (remoteId && system === LOCAL_SYSTEM_ID) {
    return refuse('INVALID_REMOTE_ID',
      `remoteId '${remoteId}' was given without a system — cc's own machine is one machine, so it has no named targets.`);
  }
  const where = remoteId ? `remote '${remoteId}' of system '${system}'` : `system '${system}'`;

  const mapError = (e: unknown): DirListRefusal => {
    const code = errCode(e);
    if (code && (isSystemRefusal(e) || e instanceof SystemError || (e && typeof e === 'object' && 'syscall' in e))) {
      return refuse(code, (e as Error).message);
    }
    throw e;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
  });
  let sys: System;
  let dirents: SystemDirent[];
  try {
    const work = (async () => {
      const s = await resolveSystem(system, remoteId, `system '${system}'`);
      return { s, d: await s.readDir(p) };
    })();
    work.catch(() => {});
    const out = await Promise.race([work, deadline]);
    if (out === TIMED_OUT) {
      return refuse('LIST_TIMEOUT', `listing '${p}' on ${where} did not answer within ${deadlineMs} ms`);
    }
    sys = out.s;
    dirents = out.d;
  } catch (e) {
    return mapError(e);
  } finally {
    clearTimeout(timer);
  }

  try {
    const { entries, links, truncated } = await selectDirs(sys, p, dirents, { linkDeadlineMs });
    return { ok: true, system, remoteId, path: p, entries, links, truncated, max: DIR_LIST_MAX_ENTRIES };
  } catch (e) {
    return mapError(e);
  }
}
