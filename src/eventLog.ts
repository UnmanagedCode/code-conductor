// The event log — `<orchStoreRoot()>/events.jsonl`, one versioned JSON row per
// line, appended and never rewritten. On-disk format (record kinds, fields,
// reader rules — plugins read it directly): docs/event-log.md.
//
// APPEND-ONLY, NEVER writeFileAtomic or a rewritten JSON document: the
// `archive-store-corruption` wiki page records the archived-session store wiping
// itself when pre-commit tests leaked into the real store from a worktree. An
// append-only file removes that class outright.
//
// The store path resolves through a LAZY per-call function (`eventLogFile`, and
// the injectable `file` option), the discipline fragmentCatalog.ts documents for
// `storeFile` — so a PROJECTS_ROOT override in a test is honoured per call.
// Resolving it at module load would make the test suite append to the real log.
//
// ONE WRITER PER PROJECTS ROOT. Order is line order — no row carries a sequence
// number — so two processes appending to one file would interleave rows each
// folded against a projection that never saw the other's. A write happens only
// while `lease.check()` answers null, and the check and the append run in the
// same synchronous step; in production the lease is the projects-root lock
// (RootLock.writerCheck, src/rootLock.ts). A refused write is dropped and
// reported, never queued: a row written later would land out of order.

import fs from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';

export const EVENT_LOG_VERSION = 1;

// Lazy — see the header. Never call this at module scope.
export function eventLogFile(): string {
  return path.join(orchStoreRoot(), 'events.jsonl');
}

export type Actor =
  // `sessionId` is the acting session's public id; absent only on migrated
  // rows and on a turn opened by parked steers from several conductors.
  | { type: 'conductor'; sessionId?: string }
  // A bound worker's own tool call, refused by its stage's `workerTools`.
  | { type: 'worker'; sessionId: string }
  | { type: 'human' }
  | { type: 'system' };

export type SessionExitCause = 'exited' | 'crashed' | 'orphaned';
export type ResumeCause = 'respawn' | 'restore' | 'prune' | 'rewind' | 'model-switch';

interface Envelope { v: typeof EVENT_LOG_VERSION; ts: string; actor: Actor; subject: string }

export interface CallRow extends Omit<Envelope, 'subject'> {
  kind: 'call';
  // Omitted ONLY on a spawn_instance call that produced no session.
  subject?: string;
  tool: string;
  outcome: 'ok' | 'refused' | 'failed';
  refusal?: { code: string; reason: string };
  failure?: { code?: string; reason: string };
  // send_prompt's forward source.
  forward?: string;
  // A stage change; `from !== to` always — a same-stage send has no `move`.
  move?: { from: string; to: string; provenance?: Record<string, string> };
  // A spawn's playbook binding.
  bind?: { playbook: string; stage: string; provenance?: Record<string, string>; project?: string; worktree?: string };
}
export interface SessionRow extends Envelope {
  kind: 'session';
  event: 'start' | 'resume' | 'exit';
  cause?: SessionExitCause | ResumeCause | 'fork';
}
export interface TurnRow extends Envelope { kind: 'turn'; event: 'start' | 'end'; stopReason?: string }
export interface WakeRow extends Envelope { kind: 'wake'; recipient: string; heartbeat?: true }
export interface ConfigRow extends Envelope { kind: 'config'; key: 'enforcement'; from?: string; to: string }

export type EventRow = CallRow | SessionRow | TurnRow | WakeRow | ConfigRow;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
// A row as handed to append() — `v` and `ts` are stamped by the writer.
export type NewEventRow = DistributiveOmit<EventRow, 'v' | 'ts'>;

const KINDS: ReadonlySet<string> = new Set(['call', 'session', 'turn', 'wake', 'config']);

// Who may write: null = this process may append now; a string = why it may not.
export interface WriteLease { check(): string | null }

export type AppendInput = NewEventRow | NewEventRow[] | (() => NewEventRow | NewEventRow[] | null);

export interface EventLog {
  // Rows from one call land as ONE write, adjacent, in array order. A thunk is
  // resolved inside the serial chain, after every earlier append has written
  // (and `onWritten` has run for it); a thunk returning null writes nothing.
  // Never rejects: a refused or failed write is reported, not thrown.
  append(input: AppendInput): Promise<void>;
  file(): string;
}

// Serialised form: `v, ts, kind, actor, subject, …` — a fixed key order, so a
// row reads the same whichever call site built it.
export function serializeRow(row: NewEventRow, ts: string): EventRow {
  const { kind, actor, subject, ...rest } = row as NewEventRow & { subject?: string };
  return {
    v: EVENT_LOG_VERSION, ts, kind, actor,
    ...(subject !== undefined ? { subject } : {}),
    ...rest,
  } as EventRow;
}

export function createEventLog(
  { file = eventLogFile, lease, onWritten, onBlocked }:
  {
    file?: () => string;
    lease: WriteLease;
    // Called synchronously for each written row, in order, inside the chain.
    onWritten?: (row: EventRow) => void;
    // Called once per blocked episode, with the first dropped row.
    onBlocked?: (reason: string, row: NewEventRow) => void;
  },
): EventLog {
  let chain: Promise<void> = Promise.resolve();
  let madeDir = false;
  let dropped = 0;
  let blocked = false;

  function step(input: AppendInput): void {
    const resolved = typeof input === 'function' ? input() : input;
    if (!resolved) return;
    const rows = Array.isArray(resolved) ? resolved : [resolved];
    if (rows.length === 0) return;
    const reason = lease.check();
    if (reason !== null) {
      if (!blocked) {
        blocked = true;
        console.error(`eventLog: not writing ${file()} — ${reason}; dropping rows until this server holds the lock again`);
        onBlocked?.(reason, rows[0]);
      }
      for (const r of rows) {
        dropped++;
        const subject = (r as { subject?: string }).subject;
        console.warn(`eventLog: dropped ${r.kind} row about ${subject ? subject.slice(0, 8) : '(no subject)'}`);
      }
      return;
    }
    const ts = new Date().toISOString();
    const full = rows.map(r => serializeRow(r, ts));
    const target = file();
    if (!madeDir) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      madeDir = true;
    }
    fs.appendFileSync(target, full.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');
    if (blocked) {
      console.log(`eventLog: writing again after dropping ${dropped} rows`);
      blocked = false;
      dropped = 0;
    }
    for (const r of full) onWritten?.(r);
  }

  function append(input: AppendInput): Promise<void> {
    chain = chain.then(() => step(input)).catch(e => {
      // The log is an audit trail, not the authority for any caller's outcome:
      // a failed write warns and the caller stands, and the catch keeps one
      // failure from poisoning every later append.
      console.warn(`eventLog: append failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return chain;
  }

  return { append, file };
}

// Read + parse the log. ENOENT reads as empty and creates nothing. A torn line
// (a crash mid-append), a non-object, another `v` or an unknown `kind` is warned
// and skipped — never folded.
export async function readEventLog(target: string): Promise<EventRow[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(target, 'utf8');
  } catch (e) {
    if ((e as { code?: unknown })?.code === 'ENOENT') return [];
    throw e;
  }
  const out: EventRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      console.warn(`eventLog: skipping malformed line in ${target}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`eventLog: skipping non-object line in ${target}`);
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.v !== EVENT_LOG_VERSION || typeof rec.kind !== 'string' || !KINDS.has(rec.kind)) {
      console.warn(`eventLog: skipping a row of v=${String(rec.v)} kind=${String(rec.kind)} in ${target}`);
      continue;
    }
    out.push(rec as unknown as EventRow);
  }
  return out;
}
