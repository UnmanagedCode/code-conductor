// The session-mode vocabulary, plus a sidecar JSON store recording the
// permission mode each session was last running under.
//
// Why the store exists: `spawn_instance({resume})` has to come back up in the
// mode the session was actually in. The CLI jsonl's `permission-mode` marker
// can't serve that — it is written in the CLI's vocabulary, which has no `ask`
// (see markerPermissionMode below), so an `ask` session cannot round-trip
// through it. This store keeps the orchestrator-level value, which is the one
// the orchestrator resumes on.
//
// There is NO backfill. Sessions that predate the store have no record and
// resolve through effectiveResumeMode() to DEFAULT_RESUME_MODE — exactly the
// behaviour they had before it existed. The record accrues going forward.
//
// Single global file `<store>/session-modes.json`, map-shaped
// (`{sessions:{sid:mode}}`) because session ids are UUIDs — no project scoping
// needed. Atomic writes (tmp + rename) behind a cross-process advisory lock,
// mirroring `conductedSessions.ts` / `sessionBackends.ts`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { withLock } from './storeLock.ts';

// Three user-facing modes:
//   - `plan`              — read-only planning; CLI is in plan mode
//   - `ask`               — full power but every destructive tool is gated
//                           by an interactive PreToolUse hook; CLI is in
//                           bypassPermissions
//   - `bypassPermissions` — full power, no gating; CLI is in bypassPermissions
// The CLI's `default`/`acceptEdits` modes are unusable in stream-json
// --print (no SDK canUseTool callback), so we don't expose them.
export const MODES = ['plan', 'ask', 'bypassPermissions'] as const;

// Start fresh instances in read-only plan mode by default. The user can pick
// `ask` or `code` (= bypassPermissions) in the new-instance dialog, or
// approve a plan to flip the running instance to bypassPermissions
// mid-session. A **resume** with no recorded mode falls back to
// `bypassPermissions` instead — a resume is almost always continuing real work
// rather than re-planning, so plan mode would be the wrong starting point.
export const DEFAULT_MODE = 'plan';
export const DEFAULT_RESUME_MODE = 'bypassPermissions';

// What a resume will ACTUALLY come up as. Every surface that reports or acts on
// a session's resume mode goes through this, so the renderer's flag, the role
// doc's claim and _doCreate's default can't drift apart: an unrecorded session
// resumes hot, and must be reported that way.
export function effectiveResumeMode(recorded: string | null | undefined): string {
  return typeof recorded === 'string' && recorded ? recorded : DEFAULT_RESUME_MODE;
}

// How an orchestrator mode is RECORDED in the CLI's own session jsonl, whose
// `permission-mode` marker the CLI reads back when it rebuilds a session (it
// both writes and reads that record, under a last-wins merge). Its vocabulary
// is `dontAsk|auto|default|acceptEdits|plan|bypassPermissions` — no `ask`, so
// `ask` is recorded as `default`: the CLI mode that prompts, which is what an
// `ask` session does. Recording it as `bypassPermissions` would tell an
// interactive `claude --resume` that a gated session ran hot.
//
// This is deliberately NOT cliPermissionMode (instances.ts), which maps
// `ask -> bypassPermissions` for the live subprocess — there the collapse is
// the mechanism: the CLI stops prompting so the orchestrator's PreToolUse hook
// can prompt instead. Conflating the two is what made the marker lossy in the
// unsafe direction; the live wire and the durable record are different
// questions and must not share a mapping.
// Throws rather than passing an unknown value through: a record that omits or
// misstates its own mode is the same defect class as one claiming a gated
// session ran hot, and both are silent at the point of writing. The callers are
// all internal (`Instance.mode` and the rewind/fork/prune paths that read it),
// so anything outside MODES here is a bug in this repo, not user input.
export function markerPermissionMode(mode: string): string {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(`markerPermissionMode: unknown orchestrator mode ${JSON.stringify(mode)}`);
  }
  return mode === 'ask' ? 'default' : mode;
}

// True when resuming in this mode gives the worker ungated tool use. `ask` is
// CLI-hot but every destructive tool is gated by the interactive hook, so it is
// not "hot" in the sense that matters here: nothing runs unattended.
export function resumesHot(mode: string): boolean {
  return mode === 'bypassPermissions';
}

function modesFile(): string {
  return path.join(orchStoreRoot(), 'session-modes.json');
}

// Parse the persisted `{sessions:{sid:mode}}` map, keeping only well-formed
// entries. The raw JSON is an untyped on-disk boundary, so this is where the
// shape is validated rather than trusted — an unrecognised mode string is
// dropped, which degrades that session to the unrecorded (hot) default rather
// than feeding an invalid mode into a spawn.
function parseMap(obj: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return out;
  const sessions = (obj as { sessions?: unknown }).sessions;
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return out;
  for (const [sid, mode] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof sid !== 'string' || !sid) continue;
    if (typeof mode !== 'string') continue;
    if (!(MODES as readonly string[]).includes(mode)) continue;
    out.set(sid, mode);
  }
  return out;
}

export async function loadAll(): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(modesFile(), 'utf8');
    return parseMap(JSON.parse(raw));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map();
    console.warn(`sessionModes: failed to read ${modesFile()}: ${errMsg(e)}`);
    return new Map();
  }
}

// The recorded mode, or null when the session predates the store / was never
// recorded. Callers resolve null through effectiveResumeMode().
export async function getSessionMode(sessionId: string | undefined): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

// Strict re-read inside a mutation (under the lock): throws on I/O / corrupt
// JSON rather than returning empty, so a failed read never overwrites the store.
async function loadStrict(): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(modesFile(), 'utf8');
    return parseMap(JSON.parse(raw));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map();
    throw e;
  }
}

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map: Map<string, string>): Promise<void> {
  const file = modesFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const sessions: Record<string, string> = {};
  for (const [sid, mode] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) sessions[sid] = mode;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({ sessions }, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Upsert the session's mode. Called on every spawn and every mode change, so
// the record tracks the live value. Idempotent: skips the write when unchanged.
export function markSessionMode(sessionId: string | undefined, mode: string | undefined): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return false;
    return withLock(modesFile(), async () => {
      const map = await loadStrict();
      if (map.get(sessionId) === mode) return true;
      map.set(sessionId, mode);
      await writeMap(map);
      return true;
    });
  });
}

export function unmarkSessionMode(sessionId: string | undefined): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(modesFile(), async () => {
      const map = await loadStrict();
      if (!map.has(sessionId)) return false;
      map.delete(sessionId);
      await writeMap(map);
      return true;
    });
  });
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
