// Destructive edits on a persisted session jsonl: truncate the tail
// before a chosen user message, or fork the prefix into a new session.
//
// The `userMessageIndex` is the 0-based position among "pure user prompt"
// lines — the same lines that emit a `user_echo` UI event when replayed.
// This keeps the index the UI hands back from a click on a user bubble
// in sync with what we count in the jsonl. See `isPureUserPromptLine`
// in transcript.ts for the predicate definition.
//
// File rewrites are atomic: write a sibling tmp file, fsync, rename over
// the target. The companion sub-agent directory (sibling to the jsonl,
// at `<encoded-cwd>/<sid>/`) is left in place — sub-agent runs are
// uniquely-named per Agent tool_use_id, so stale entries are harmless
// and can be cleaned up by other code paths (or by the user explicitly
// deleting the session).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeCwd, claudeProjectsRoot } from './projects.ts';
import { isPureUserPromptLine, writeSessionMetadata, type PersistedLine } from './transcript.ts';
import { extractAttachedMarkers, type WireContentBlock } from './parser.ts';

function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
}

// Parse one trimmed jsonl line, swallowing parse errors (mirrors the
// tolerant behavior of loadPersistedTranscript).
function tryParse(line: string): unknown {
  try { return JSON.parse(line); }
  catch { return null; }
}

// Pull the prompt text that produced a user_echo when this object is
// replayed. Used to prefill the composer after a rewind/fork. Mirrors the
// consolidation logic in transcript.ts: text blocks joined with newlines,
// attachment markers stripped via parser.ts's `extractAttachedMarkers` (the
// same store-path-anchored matcher the live/replay path uses, so prefill
// can never diverge from what the bubble showed).
function extractUserPromptText(obj: PersistedLine | null | undefined): string {
  // `type:"attachment"` queued_command lines stash the text blocks under
  // `attachment.prompt` instead of `message.content` — same block shape,
  // different envelope. Pick the right source so composer prefill works
  // when the rewind/fork target is a queued prompt (e.g. auto-approve).
  let content: unknown;
  if (obj?.type === 'attachment' && obj.attachment?.type === 'queued_command') {
    content = obj.attachment.prompt;
  } else {
    content = obj?.message?.content;
  }
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as WireContentBlock[]) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
    // Strip attachment marker lines we wrote at send time so they don't
    // get prefilled back into the composer as visible prose.
    const { text: leftover } = extractAttachedMarkers(b.text);
    if (leftover.length) parts.push(leftover);
  }
  return parts.join('\n');
}

// Read the jsonl, walk it line-by-line, and return:
//   - prefixLines: the raw lines (objects) that survive before the target
//   - droppedLines: the lines from the target onward (including the user
//     line itself)
//   - droppedText: the prompt text of the target user message
//   - lastSurvivingUuid: uuid of the last prefix line, or null
// Throws { statusCode: 400 } if the target index isn't found.
async function readAndSplit({ cwd, sessionId, userMessageIndex }: {
  cwd: string; sessionId: string; userMessageIndex: number;
}): Promise<{
  prefix: Array<{ raw: string; obj: PersistedLine | null }>;
  dropped: Array<{ raw: string; obj: PersistedLine | null }>;
  droppedText: string;
  lastSurvivingUuid: string | null;
}> {
  const file = sessionFilePath(cwd, sessionId);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') {
      throw httpError(404, `session ${sessionId} not found`);
    }
    throw e;
  }
  // Split preserving line boundaries — the file may or may not end with a
  // trailing newline. We re-emit with `\n` per kept line on writeback.
  const rawLines = text.split('\n');
  const prefix: Array<{ raw: string; obj: PersistedLine | null }> = [];
  const dropped: Array<{ raw: string; obj: PersistedLine | null }> = [];
  let target: PersistedLine | null = null;
  let userCount = 0;
  let crossed = false;
  let lastSurvivingUuid: string | null = null;

  for (const raw of rawLines) {
    if (!raw.length) continue; // skip empty trailing line from final `\n`
    const parsed = tryParse(raw);
    const obj: PersistedLine | null = parsed && typeof parsed === 'object' ? parsed as PersistedLine : null;
    if (!obj) {
      // Unparseable line — keep it on the prefix side until we've crossed
      // the threshold, then drop it on the tail side. This is best-effort
      // — should never happen with a CLI-written jsonl.
      (crossed ? dropped : prefix).push({ raw, obj: null });
      continue;
    }
    if (!crossed && isPureUserPromptLine(obj)) {
      if (userCount === userMessageIndex) {
        target = obj;
        crossed = true;
        dropped.push({ raw, obj });
        continue;
      }
      userCount++;
    }
    if (crossed) {
      dropped.push({ raw, obj });
    } else {
      prefix.push({ raw, obj });
      if (typeof obj.uuid === 'string') lastSurvivingUuid = obj.uuid;
    }
  }

  if (!target) {
    throw httpError(400, `userMessageIndex ${userMessageIndex} out of range (session has ${userCount} user prompts)`);
  }

  return {
    prefix,
    dropped,
    droppedText: extractUserPromptText(target),
    lastSurvivingUuid,
  };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}-${path.basename(file)}`);
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

function joinLines(entries: Array<{ raw: string }>): string {
  if (entries.length === 0) return '';
  // Each line gets a trailing `\n` — preserves the canonical jsonl shape.
  return entries.map(e => e.raw).join('\n') + '\n';
}

// Truncate <cwd>/<sessionId>.jsonl so that everything from the Nth pure
// user-prompt line onward is dropped. Returns { droppedText, droppedLineCount,
// remainingLineCount, lastSurvivingUuid }.
//
// After the rewrite, appends a fresh last-prompt / permission-mode metadata
// pair pointing at lastSurvivingUuid (skipped when N==0 — the empty-history
// case where no leaf exists to anchor the picker).
export async function truncateSessionAtUserMessage({ cwd, sessionId, userMessageIndex, permissionMode }: {
  cwd: string; sessionId: string; userMessageIndex: number; permissionMode?: string;
}): Promise<{ droppedText: string; droppedLineCount: number; remainingLineCount: number; lastSurvivingUuid: string | null }> {
  if (!cwd || !sessionId) throw new Error('cwd + sessionId required');
  if (!Number.isInteger(userMessageIndex) || userMessageIndex < 0) {
    throw httpError(400, 'userMessageIndex must be a non-negative integer');
  }
  const { prefix, dropped, droppedText, lastSurvivingUuid } =
    await readAndSplit({ cwd, sessionId, userMessageIndex });

  const file = sessionFilePath(cwd, sessionId);
  await writeAtomic(file, joinLines(prefix));

  // Append fresh resume-picker metadata for the new tail. Best-effort —
  // skipped when there's no surviving leaf (truncate to empty) since the
  // picker line requires a leafUuid.
  if (lastSurvivingUuid) {
    await writeSessionMetadata({
      cwd, sessionId,
      leafUuid: lastSurvivingUuid,
      permissionMode: permissionMode ?? 'bypassPermissions',
    });
  }

  return {
    droppedText,
    droppedLineCount: dropped.length,
    remainingLineCount: prefix.length,
    lastSurvivingUuid,
  };
}

// Copy the prefix of <cwd>/<sessionId>.jsonl up to (excluding) the Nth user
// prompt line into a new file <cwd>/<newSessionId>.jsonl. The original
// session jsonl is untouched. Rewrites the `sessionId` field inside each
// copied line to the new id — purely cosmetic (the filename is what
// `--resume` reads) but keeps the file self-consistent for any downstream
// tooling. Returns { newSessionId, droppedText, lastSurvivingUuid }.
export async function forkSessionAtUserMessage({ cwd, sessionId, userMessageIndex, permissionMode, newSessionId }: {
  cwd: string; sessionId: string; userMessageIndex: number; permissionMode?: string; newSessionId?: string;
}): Promise<{ newSessionId: string; droppedText: string; lastSurvivingUuid: string | null }> {
  if (!cwd || !sessionId) throw new Error('cwd + sessionId required');
  if (!Number.isInteger(userMessageIndex) || userMessageIndex < 0) {
    throw httpError(400, 'userMessageIndex must be a non-negative integer');
  }
  const { prefix, droppedText, lastSurvivingUuid } =
    await readAndSplit({ cwd, sessionId, userMessageIndex });

  const newSid = newSessionId ?? randomUUID();
  const newFile = sessionFilePath(cwd, newSid);

  // Rewrite each line's `sessionId` field (when present) to the new id.
  // Lines we couldn't parse are passed through verbatim.
  const rewritten = prefix.map(({ raw, obj }): { raw: string } => {
    if (!obj) return { raw };
    if (typeof obj.sessionId !== 'string') return { raw };
    const copy = { ...obj, sessionId: newSid };
    return { raw: JSON.stringify(copy) };
  });

  await writeAtomic(newFile, joinLines(rewritten));

  // Anchor the new session in the resume picker. Skipped when prefix is
  // empty (forking from N=0 — no surviving leaf, equivalent to a fresh
  // sessionId no one has driven yet).
  if (lastSurvivingUuid) {
    await writeSessionMetadata({
      cwd, sessionId: newSid,
      leafUuid: lastSurvivingUuid,
      permissionMode: permissionMode ?? 'bypassPermissions',
    });
  }

  return {
    newSessionId: newSid,
    droppedText,
    lastSurvivingUuid,
  };
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

// Throw an Error carrying an HTTP statusCode for the REST layer, using the
// same Object.assign pattern the routes consume (`err.statusCode`).
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
