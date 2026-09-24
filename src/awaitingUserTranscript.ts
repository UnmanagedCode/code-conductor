// `awaitingUser` derived from a session's persisted transcript — the disk feed
// of src/awaitingUser.ts. Used to hydrate an Instance at launch and to fill
// the inactive SessionRows.
//
// Each segment is scanned BACKWARD in fixed-size chunks and the scan stops at
// the newest decisive fact (a tool ask or a real user turn), so the cost is the
// distance to that fact, not the file size. Segments are walked newest→oldest,
// composing summaries until one is decisive.
//
// Every line goes through replayPersistedLine in isolation, so the disk feed
// sees exactly the user_echo / user_question / plan_request events a replay
// does (queued_command prompts, task-notification drops, the sidechain skip,
// the cliInjected stamp). The one fact replay does not carry is the end of a
// turn: the jsonl has no `result` line, so a run of assistant records sharing
// message.id is one message, and only its FINAL record's stop_reason is read —
// earlier per-block records carry an absent or null one on some backends.
//
// Memo: process-lifetime, keyed by absolute path, not persisted. An unchanged
// stat is a hit; the same inode grown is scanned only from where the last scan
// stopped (re-reading the trailing assistant message, which a later record may
// still extend); anything else — shrunk, new inode — is a full rescan. So an
// incremental read always equals a full scan of the same bytes.

import { promises as fs } from 'node:fs';
import { sessionFilePath, type TranscriptPlacement } from './projects.ts';
import { replayPersistedLine, type PersistedLine } from './transcript.ts';
import {
  askFactsOfEvent, summaryOfFact, composeSummaries, applySummary, IDENTITY_SUMMARY,
  type AskFact, type AskState, type AskSummary,
} from './awaitingUser.ts';

const CHUNK_BYTES = 64 * 1024;

interface StatLike { dev: number; ino: number; ctimeMs: number; mtimeMs: number; size: number; isFile(): boolean }
interface ReadHandle {
  read(buf: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
// Injectable so a test can count the bytes a scan reads.
export interface TranscriptIO {
  stat(p: string): Promise<StatLike>;
  open(p: string): Promise<ReadHandle>;
}
const defaultIO: TranscriptIO = { stat: (p) => fs.stat(p), open: (p) => fs.open(p, 'r') };

interface MemoEntry {
  dev: number; ino: number; ctimeMs: number; mtimeMs: number; size: number;
  // Offset the next incremental scan starts from: the start of the trailing
  // assistant message, or the end of the last complete line when there is none.
  scannedTo: number;
  base: AskSummary; // summary of [0, scannedTo)
  full: AskSummary; // summary of every complete line
}
const memo = new Map<string, MemoEntry>();

// `ids` oldest→newest with `newest` moved to the end (appended once, wherever
// it appeared). A resumed instance's segment list already ends with the id it
// resumes; a respawn's may not.
export function chainEndingAt(ids: readonly string[], newest: string): string[] {
  return [...ids.filter(id => id !== newest), newest];
}

// The session's state across its live segments, oldest→newest. A segment
// whose transcript is missing contributes nothing.
export async function deriveAwaitingUser(
  place: TranscriptPlacement, segmentIds: readonly string[], { io = defaultIO }: { io?: TranscriptIO } = {},
): Promise<AskState> {
  let acc = IDENTITY_SUMMARY;
  for (let i = segmentIds.length - 1; i >= 0 && acc.t !== 'const'; i--) {
    acc = composeSummaries(acc, await segmentSummary(sessionFilePath(place, segmentIds[i]), io));
  }
  return applySummary(acc, null);
}

async function segmentSummary(file: string, io: TranscriptIO): Promise<AskSummary> {
  let st: StatLike;
  try { st = await io.stat(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { memo.delete(file); return IDENTITY_SUMMARY; }
    throw e;
  }
  if (!st.isFile()) return IDENTITY_SUMMARY;
  const prev = memo.get(file);
  if (prev && prev.dev === st.dev && prev.ino === st.ino && prev.size === st.size
    && prev.ctimeMs === st.ctimeMs && prev.mtimeMs === st.mtimeMs) {
    return prev.full;
  }
  const grown = !!prev && prev.dev === st.dev && prev.ino === st.ino && st.size >= prev.size;
  const from = grown ? prev.scannedTo : 0;
  const fh = await io.open(file);
  let region: RegionScan;
  try { region = await scanRegion(fh, from, st.size); }
  finally { await fh.close(); }
  const base = grown ? composeSummaries(region.body, prev.base) : region.body;
  const full = composeSummaries(region.tail, base);
  memo.set(file, {
    dev: st.dev, ino: st.ino, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs, size: st.size,
    scannedTo: region.bodyEnd, base, full,
  });
  return full;
}

// Complete lines of [from, to), newest first, each with its start offset. The
// bytes after the last newline are a line still being written and are not
// yielded; `from` is always a line start.
async function* linesBackward(fh: ReadHandle, from: number, to: number): AsyncGenerator<{ text: string; start: number; end: number }> {
  let pos = to;
  let carry = Buffer.alloc(0);
  let sawNewline = false;
  while (pos > from) {
    const len = Math.min(CHUNK_BYTES, pos - from);
    pos -= len;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    const data = Buffer.concat([buf.subarray(0, bytesRead), carry]);
    let end = data.length;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== 0x0a) continue;
      if (sawNewline && end > i + 1) yield { text: data.subarray(i + 1, end).toString('utf8'), start: pos + i + 1, end: pos + end };
      sawNewline = true;
      end = i;
    }
    carry = Buffer.from(data.subarray(0, end));
  }
  if (sawNewline && carry.length) yield { text: carry.toString('utf8'), start: from, end: from + carry.length };
}

interface RegionScan {
  // Summary of the trailing assistant message — re-read by the next incremental
  // scan, since a later record of the same message.id may still extend it.
  tail: AskSummary;
  body: AskSummary; // summary of [from, bodyEnd)
  bodyEnd: number;
}

// Scan [from, to) backward, stopping once the body summary is decisive.
async function scanRegion(fh: ReadHandle, from: number, to: number): Promise<RegionScan> {
  let tail = IDENTITY_SUMMARY;
  let body = IDENTITY_SUMMARY;
  let completeEnd: number | null = null;
  let tailStart: number | null = null;
  // 'start' until the newest conversational line is met; 'tail' while inside a
  // trailing assistant message; 'body' for everything older.
  let phase: 'start' | 'tail' | 'body' = 'start';
  // The assistant run (one message) the scan is inside; its end-of-turn text is
  // still wanted until a text block is met.
  let runId: string | null = null;
  let runWantsText = false;

  const push = (fact: AskFact) => {
    if (phase === 'tail') tail = composeSummaries(tail, summaryOfFact(fact));
    else body = composeSummaries(body, summaryOfFact(fact));
  };

  for await (const { text, start, end } of linesBackward(fh, from, to)) {
    if (completeEnd === null) completeEnd = end + 1;
    let obj: PersistedLine;
    try { obj = JSON.parse(text); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    // replayPersistedLine drops these too; dropping them BEFORE run grouping
    // keeps an inline sub-agent trace from contributing an end-of-turn text.
    if (obj.isSidechain) continue;

    if (obj.type === 'assistant') {
      const msg = obj.message ?? {};
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (id === null || id !== runId) {
        // The first line met for a run is its final record SO FAR; only its
        // stop_reason says how the message ended. A trailing message is never
        // taken as finished, whatever that value: a stale non-null stop_reason
        // is written on per-block records too, and a later record can follow.
        const stop = (msg as { stop_reason?: unknown }).stop_reason;
        if (phase === 'start') phase = 'tail';
        else if (phase === 'tail') phase = 'body';
        runId = id;
        runWantsText = stop === 'end_turn';
      }
      if (phase === 'tail') tailStart = start;
      if (runWantsText) {
        // Positioned after the whole run in forward order; an end_turn message
        // carries no tool_use, so nothing else in the run can follow it.
        const last = lastTextBlock(msg.content);
        if (last !== null) { push({ t: 'endTurn', text: last }); runWantsText = false; }
      }
    } else if (obj.type === 'user' || (obj.type === 'attachment' && obj.attachment?.type === 'queued_command')) {
      runId = null;
      runWantsText = false;
      phase = 'body';
    } else {
      continue; // metadata lines (other attachments, snapshots, markers) break no run
    }
    const facts = replayPersistedLine(obj).flatMap(askFactsOfEvent);
    for (let i = facts.length - 1; i >= 0; i--) push(facts[i]);
    if (phase === 'body' && body.t === 'const') break;
  }
  const bodyEnd = tailStart ?? completeEnd ?? from;
  return { tail, body, bodyEnd };
}

function lastTextBlock(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as { type?: unknown; text?: unknown } | null;
    if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}
