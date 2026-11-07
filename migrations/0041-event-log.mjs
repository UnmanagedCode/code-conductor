// Migration 0041: the playbook ledger becomes the event log.
//
// Before (under <root>/.code-conductor/):
//   playbook-ledger.jsonl   one row per line, {seq, ts, kind, …}, kinds spawn /
//                           transition / refusal / interaction / retire / resume
//                           / enforcement / wake
// After:
//   events.jsonl            one row per line, {v:1, ts, kind, actor, subject, …},
//                           kinds call / session / config / wake — same rows, same
//                           order, same `ts`; `seq` dropped (order is line order)
//   migrated-backup-0041/playbook-ledger.jsonl   the old file, moved aside
//
// Mapping (actor is {type:'conductor'} with no sessionId on call rows unless the
// old row named the conductor, {type:'system'} on every other row):
//   spawn       → call {tool:'spawn_instance', outcome:'ok', bind:{playbook, stage, provenance?, project?, worktree?}}
//   transition  → call {tool: via, outcome:'ok', move:{from, to, provenance?}, forward?} — WITHOUT `move` when from === to
//   refusal     → call {subject?, tool, outcome:'refused', refusal:{code, reason}, forward?}
//   interaction → call {actor:{type:'conductor', sessionId: conductorSessionId}, tool, outcome:'ok', forward?}
//   retire      → session {event:'exit', cause} — 'subprocess X' → X, 'orphaned…' → orphaned
//   resume      → session {event:'resume'}
//   enforcement → config {subject: conductorSessionId, key:'enforcement', from? (omitted when null), to}
//   wake        → wake {subject: sessionId, recipient: conductorSessionId, heartbeat?}
// An old `needs` field (an earlier name the fold already ignored) is dropped and
// counted. Torn lines and unknown kinds are skipped and counted, as the old
// reader skipped them.
//
// ── PROBE ──────────────────────────────────────────────────────────────────
// No playbook-ledger.jsonl → no-op.
//
// ── CRASH RESUME ───────────────────────────────────────────────────────────
// The conversion is deterministic (fixed key order, copied `ts`), so an
// events.jsonl byte-identical to it is this migration's own output from a run
// that died before the move-aside: the move-aside completes. An events.jsonl
// that differs is refused — both files exist and neither may be dropped.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0041-event-log';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v !== '';

function stringMap(v) {
  if (!isObject(v)) return null;
  const out = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return Object.keys(out).length > 0 ? out : null;
}

function exitCause(reason) {
  if (typeof reason !== 'string') return 'exited';
  if (reason.startsWith('orphaned')) return 'orphaned';
  return reason.startsWith('subprocess ') ? reason.slice('subprocess '.length) : reason;
}

// One old row → one new row in fixed key order, or a skip reason.
function convertRow(rec, counts) {
  const ts = rec.ts;
  if (typeof ts !== 'string') return null;
  const head = (kind, actor, subject) => ({ v: 1, ts, kind, actor, ...(subject !== undefined ? { subject } : {}) });
  const conductor = { type: 'conductor' };
  const system = { type: 'system' };
  switch (rec.kind) {
    case 'spawn': {
      if (!str(rec.sessionId) || !str(rec.playbook) || !str(rec.stage)) return null;
      const provenance = stringMap(rec.provenance);
      return {
        ...head('call', conductor, rec.sessionId), tool: 'spawn_instance', outcome: 'ok',
        bind: {
          playbook: rec.playbook, stage: rec.stage,
          ...(provenance ? { provenance } : {}),
          ...(typeof rec.project === 'string' ? { project: rec.project } : {}),
          ...(typeof rec.worktree === 'string' ? { worktree: rec.worktree } : {}),
        },
      };
    }
    case 'transition': {
      if (!str(rec.sessionId) || !str(rec.from) || !str(rec.to)) return null;
      const provenance = stringMap(rec.provenance);
      const self = rec.from === rec.to;
      if (self) {
        counts.selfLoops++;
        if (provenance) counts.droppedSelfLoopProvenance++;
      }
      return {
        ...head('call', conductor, rec.sessionId), tool: str(rec.via) ? rec.via : 'send_prompt', outcome: 'ok',
        ...(str(rec.forwardSessionId) ? { forward: rec.forwardSessionId } : {}),
        ...(self ? {} : { move: { from: rec.from, to: rec.to, ...(provenance ? { provenance } : {}) } }),
      };
    }
    case 'refusal': {
      if (!str(rec.tool)) return null;
      return {
        ...head('call', conductor, str(rec.sessionId) ? rec.sessionId : undefined), tool: rec.tool, outcome: 'refused',
        refusal: { code: String(rec.code ?? ''), reason: String(rec.reason ?? '') },
        ...(str(rec.forwardSessionId) ? { forward: rec.forwardSessionId } : {}),
      };
    }
    case 'interaction': {
      if (!str(rec.sessionId) || !str(rec.tool)) return null;
      const actor = str(rec.conductorSessionId) ? { type: 'conductor', sessionId: rec.conductorSessionId } : conductor;
      return {
        ...head('call', actor, rec.sessionId), tool: rec.tool, outcome: 'ok',
        ...(str(rec.forwardSessionId) ? { forward: rec.forwardSessionId } : {}),
      };
    }
    case 'retire':
      if (!str(rec.sessionId)) return null;
      return { ...head('session', system, rec.sessionId), event: 'exit', cause: exitCause(rec.reason) };
    case 'resume':
      if (!str(rec.sessionId)) return null;
      return { ...head('session', system, rec.sessionId), event: 'resume' };
    case 'enforcement':
      if (!str(rec.conductorSessionId) || !str(rec.to)) return null;
      return {
        ...head('config', system, rec.conductorSessionId), key: 'enforcement',
        ...(str(rec.from) ? { from: rec.from } : {}), to: rec.to,
      };
    case 'wake':
      if (!str(rec.sessionId) || !str(rec.conductorSessionId)) return null;
      return {
        ...head('wake', system, rec.sessionId), recipient: rec.conductorSessionId,
        ...(rec.heartbeat === true ? { heartbeat: true } : {}),
      };
    default:
      return 'unknown';
  }
}

// The whole conversion, in file order. Exported for the test's dry runs.
export function convertLedger(raw) {
  const counts = { rows: 0, byKind: {}, skippedMalformed: 0, skippedUnknown: 0, droppedNeeds: 0, selfLoops: 0, droppedSelfLoopProvenance: 0 };
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { counts.skippedMalformed++; continue; }
    if (!isObject(rec) || typeof rec.kind !== 'string') { counts.skippedMalformed++; continue; }
    const out = convertRow(rec, counts);
    if (out === 'unknown') { counts.skippedUnknown++; continue; }
    if (out === null) { counts.skippedMalformed++; continue; }
    counts.rows++;
    if ('needs' in rec) counts.droppedNeeds++;
    counts.byKind[out.kind] = (counts.byKind[out.kind] ?? 0) + 1;
    lines.push(JSON.stringify(out) + '\n');
  }
  return { text: lines.join(''), summary: counts };
}

async function readOrNull(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function exists(p) {
  try { await fs.lstat(p); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const store = path.join(projectsRoot, '.code-conductor');
  const oldFile = path.join(store, 'playbook-ledger.jsonl');
  const newFile = path.join(store, 'events.jsonl');

  const raw = await readOrNull(oldFile);
  if (raw === null) return { applied: false };
  const { text, summary } = convertLedger(raw);

  const existing = await readOrNull(newFile);
  if (existing !== null) {
    if (existing !== text) {
      throw new Error(`${name}: events.jsonl and playbook-ledger.jsonl both exist and differ — move one aside and restart (${store})`);
    }
    log(`  ${name}: events.jsonl already holds the conversion; completing the move-aside`);
  } else {
    const tmp = `${newFile}.tmp-0041`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, newFile);
  }

  const backupDir = path.join(store, 'migrated-backup-0041');
  await fs.mkdir(backupDir, { recursive: true });
  let dest = path.join(backupDir, 'playbook-ledger.jsonl');
  if (await exists(dest)) dest = path.join(backupDir, `playbook-ledger.jsonl-${Date.now()}`);
  await fs.rename(oldFile, dest);

  return { applied: true, summary };
}
