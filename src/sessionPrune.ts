// Prune: deterministic, zero-token context compaction of a session jsonl.
//
// Copies a session's jsonl into a NEW sessionId, replacing the fat, low-value
// parts of the conversation — tool outputs, oversized tool inputs, thinking —
// with short stubs. No LLM pass: this is a mechanical file transform. The
// original file is never mutated (the caller archives it).
//
// Sibling of sessionEdit.ts (rewind/fork) and shares its conventions: atomic
// tmp+rename write, `sessionId` rewritten inside each copied line, resume-picker
// metadata appended for the new id.
//
// ── INVARIANTS (load-bearing — derived by probing the real CLI, do not "clean
//    up") ────────────────────────────────────────────────────────────────────
// The Claude CLI rebuilds its read-before-edit cache (`readFileState`) by
// REPLAYING THE TRANSCRIPT on resume: it reads `input.file_path` off every
// Read/Write/Edit `tool_use` and pairs it with the matching `tool_result`.
// Therefore:
//
//   1. NEVER rewrite a `tool_use.input` object's key set. Only string VALUES
//      are edited, and path-bearing keys are never touched at all. Replacing an
//      input with a marker object drops `file_path`, the harness loses the file,
//      and every later Edit in the pruned session fails with "File has not been
//      read yet" (measured, on claude-haiku-4-5).
//   2. NEVER touch `toolUseResult`. It is a disk-only sidecar (NOT in the
//      model's context, so pruning it saves zero context), and its ABSENCE is
//      the CLI's discriminator for "this is a human user turn" — clearing it
//      corrupts turn counting and last-human-message lookups.
//   3. `tool_result.content` stays a STRING — EXCEPT for pruned Read/Write
//      results, which deliberately become a content-block array. See
//      PRUNE_STUB_AS_BLOCKS: the CLI only reconstructs a readFileState entry
//      when `typeof content === "string"`, so the array form is what makes the
//      read-before-edit guard RE-ARM after the file's content leaves the
//      context. Normalizing that back to a string would look like a cleanup and
//      would silently re-break the guarantee.
//
// Two further structural rules come from the feature brief and are equally
// load-bearing:
//   4. No entry and no block is EVER removed — only block content is replaced.
//      Because nothing is removed, the `parentUuid` chain never needs relinking
//      and the tool_use/tool_result pairing invariant (every tool_use answered,
//      no empty content array) cannot be violated.
//   5. Sidechain (sub-agent) entries are never pruned — the user wants them
//      fully readable in the GUI.
//   6. Some tools are EXEMPT by name: their `tool_use` and the `tool_result`
//      answering it are copied verbatim in every mode. See isPruneExemptTool.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeCwd, claudeProjectsRoot } from './projects.ts';
import { isPureUserPromptLine, writeSessionMetadata, type PersistedLine } from './transcript.ts';
import type { WireContentBlock } from './parser.ts';

// Stub shape for a pruned Read/Write tool_result. `true` (the default) makes the
// stub a content-block array instead of a plain string.
//
// This is not cosmetic. The CLI reconstructs a readFileState entry only when
// `typeof tool_result.content === "string"`; the array form fails that test, the
// entry is dropped, and the read-before-edit guard RE-ARMS. That is the point:
// the guard exists to guarantee the model holds current file content in context
// before mutating a file, and pruning is precisely the act of removing that
// content. A string stub would keep the guard satisfied while what's actually in
// context is a size marker — the harness asserting something false. The concrete
// failure that protects against is a model reconstructing an `old_string` from its
// narrative memory of a file it can no longer see, and either failing the match or
// hitting the wrong occurrence. The cost of re-arming is one refused Edit per
// file, self-corrected by a re-Read: the mechanism working as designed.
//
// Scope: Read and Write results only (SEEDING_TOOLS) — those are the two whose
// tool_result content seeds readFileState. Every other tool's output keeps the
// plain string stub. An Edit-seeded entry is out of reach either way: the CLI
// re-reads that file from DISK using only `input.file_path` and a non-error
// result, neither of which Prune may touch (invariant 1).
//
// Flip to `false` to go back to string stubs everywhere (guard stays satisfied,
// no re-Read tax, harness bookkeeping stale).
export const PRUNE_STUB_AS_BLOCKS = true;

// Tools whose tool_result content the CLI turns into a readFileState entry.
//
// The CLI's reconstruction pass branches on exactly THREE tool names — Read,
// Write and Edit — and nothing else. Of those:
//   Read  → cache content comes from the tool_result's `content`  ⇒ seeding
//   Write → cache content comes from the tool_use's `input.content` ⇒ seeding
//           (its result only has to exist and be non-error)
//   Edit  → the CLI re-reads the file from DISK; the result content is
//           irrelevant, so a block array would change nothing ⇒ not listed
// `NotebookEdit` is a defined tool-name constant in the bundle but is NEVER
// referenced by the reconstruction pass, so a notebook result cannot seed the
// cache and does not belong here. (NotebookEdit *does* check readFileState and
// refuses with "File has not been read yet" when it's empty — but since nothing
// ever seeds it from a transcript, a notebook edit already needs a live Read
// after ANY resume. Pruning neither causes nor worsens that.)
const SEEDING_TOOLS = new Set(['Read', 'Write']);

// ── the exemption (invariant 6) ─────────────────────────────────────────────

// The orchestrator's own MCP server name is pinned to `code-conductor`
// (src/settings.ts buildMcpConfigJSON), so every tool it exposes carries this
// prefix. `__` is the segment separator, so what follows is `<tool>` for a CORE
// tool and `<plugin-id>__<tool>` for a plugin-forwarded one.
export const CONDUCTOR_MCP_PREFIX = 'mcp__code-conductor__';

// The two core conductor tools that stay PRUNABLE. Their results are bulk file /
// command output — precisely what Prune exists to shed — where every other core
// tool's payload is orchestration record. Hardcoded rather than configurable:
// which of the two a tool is, is a property of the tool, not a user preference.
export const PRUNABLE_CONDUCTOR_MCP_TOOLS = new Set([
  `${CONDUCTOR_MCP_PREFIX}project_read`,
  `${CONDUCTOR_MCP_PREFIX}project_bash`,
]);

// INVARIANT 6. True for a tool whose `tool_use` — and the `tool_result` answering
// it — must be copied VERBATIM in every mode, at any cut.
//
//   AskUserQuestion: the question card is rebuilt entirely from
//   `input.questions` on replay (transcript.ts), and the answer is recovered by
//   STRING-MATCHING the question text and option labels against the user echo
//   that follows (public/userQuestionAnswers.js, driven from
//   public/conversation.js). Squeezing either side leaves the human with an
//   unreadable question and silently drops the answer off the card.
//
//   Core conductor MCP calls: the orchestration record — what was spawned,
//   approved, merged, filed. Exempt as a NAMESPACE so a core tool added later is
//   exempt by default, minus PRUNABLE_CONDUCTOR_MCP_TOOLS.
//
// Matching the prefix alone is NOT enough. What remains after the prefix must
// also contain no further `__`: a plugin-forwarded tool carries one
// (`…__code-kanban__file_task`, or a third-party `…__acme-tools__run`) and its
// payload is ordinary bulk
// output that stays prunable by default. The separator tested is `__`, not `_`,
// which is what keeps a core tool whose own name contains a single underscore —
// `spawn_instance`, `merge_worktree` — on the exempt side. Testing for `__` and
// not for a first-party plugin naming habit (`code-*`) is deliberate: a
// third-party plugin id must classify the same way.
export function isPruneExemptTool(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name === 'AskUserQuestion') return true;
  if (!name.startsWith(CONDUCTOR_MCP_PREFIX)) return false;
  const rest = name.slice(CONDUCTOR_MCP_PREFIX.length);
  if (!rest || rest.includes('__')) return false;   // plugin-namespaced ⇒ prunable
  return !PRUNABLE_CONDUCTOR_MCP_TOOLS.has(name);
}

// Truncate mode: string values in a tool input longer than this keep their first
// PRUNE_INPUT_MAX characters. Chosen so a typical Edit's old_string/new_string
// still renders usefully in the diff view.
export const PRUNE_INPUT_MAX = 500;

// Minimal mode: string values longer than this are squeezed to a size marker.
// Short scalars (paths, flags, globs, short commands) pass through, which is what
// preserves the narrative — the model still sees WHICH file was read.
const MINIMAL_INPUT_MAX = 80;

// Never touched in any mode, at any depth. `file_path`/`notebook_path` are the
// keys the CLI's readFileState reconstruction reads (invariant 1).
const PATH_KEYS = new Set(['file_path', 'notebook_path']);

const THINKING_STUB = '[pruned: thinking]';

export const INPUT_MODES = new Set(['truncate', 'minimal']);

type InputMode = 'truncate' | 'minimal';

// The subset of a content block the transform reads/writes. All fields stay
// `unknown` (JSON-parsed); the switch in pruneBlock narrows per type.
interface PruneBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  data?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
}

interface PruneOpts {
  inCut: boolean;
  pruneThinking: boolean;
  exemptThinking: boolean;
  toolNames: Map<string, string | undefined>;
  inputMode: InputMode;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Rough token estimate. Mirrors the shape of the CLI's own per-block accounting
// (text → text, thinking → thinking, tool_use → name + JSON(input), tool_result →
// content) at ~4 chars/token. The brief only asks for a heuristic; what matters is
// that it is computed over IN-CONTEXT entries only (see analyzeSessionForPrune).
// Non-string input coerces to '' (was NaN before, when a malformed block carried
// a numeric field).
const approxTokens = (s: unknown): number => Math.ceil((typeof s === 'string' ? s : '').length / 4);

function blockTokens(block: PruneBlock | null | undefined): number {
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return approxTokens(block.text);
    case 'thinking': return approxTokens(block.thinking);
    case 'redacted_thinking': return approxTokens(block.data);
    case 'tool_use': return approxTokens(String(block.name ?? '') + JSON.stringify(block.input ?? {}));
    case 'tool_result': return approxTokens(
      typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
    );
    default: return approxTokens(JSON.stringify(block));
  }
}

// ── the stubs ───────────────────────────────────────────────────────────────

// `toolName` is the name of the tool_use this result answers (null when unknown —
// e.g. an orphaned result), and decides the stub SHAPE. See PRUNE_STUB_AS_BLOCKS.
function stubToolResultContent(content: unknown, toolName: string | undefined): Array<{ type: string; text: string }> | string {
  const bytes = Buffer.byteLength(
    typeof content === 'string' ? content : JSON.stringify(content ?? ''), 'utf8',
  );
  const text = `[pruned: ${humanBytes(bytes)}]`;
  return PRUNE_STUB_AS_BLOCKS && toolName != null && SEEDING_TOOLS.has(toolName)
    ? [{ type: 'text', text }]
    : text;
}

// THE single block transform — both the savings preview and the actual rewrite
// call this, so the number the dialog shows can never drift from what Prune does.
//
// Returns { block, category, saved }. `saved` is the token delta and is never
// negative: a stub that would be BIGGER than what it replaces (an empty thinking
// block, a two-byte tool output) is skipped and the original block is returned
// verbatim. Pruning must never inflate the context.
function pruneBlock(block: PruneBlock | null | undefined, { inCut, pruneThinking, exemptThinking, toolNames, inputMode }: PruneOpts): {
  block: PruneBlock | null | undefined; category: string | null; saved: number;
} {
  const none = { block, category: null, saved: 0 };
  if (!block || typeof block !== 'object') return none;

  let next: PruneBlock | null = null;
  let category: string | null = null;
  if (block.type === 'thinking') {
    // Global, not gated on the cut (thinking staleness is categorical, not
    // temporal) — minus the unresolved-tool_use exemption. `signature` is
    // deliberately LEFT IN PLACE: an unsigned thinking block survives the CLI's
    // own other-model strip pass (which only removes SIGNED blocks) and would
    // then reach the API unsigned. Measured: replacing the text while keeping the
    // signature provokes no rejection.
    if (!pruneThinking || exemptThinking) return none;
    next = { ...block, thinking: THINKING_STUB };
    category = 'thinking';
  } else if (!inCut) {
    return none;
  } else if (block.type === 'tool_result') {
    // Invariant 6 — an exempt tool's result rides along with its tool_use. An
    // ORPHANED result (no tool_use in context, so no name) stays prunable.
    const toolName = toolNames.get(block.tool_use_id as string);
    if (isPruneExemptTool(toolName)) return none;
    next = {
      ...block,
      content: stubToolResultContent(block.content, toolName),
    };
    category = 'toolOutputs';
  } else if (block.type === 'tool_use') {
    if (isPruneExemptTool(block.name)) return none;   // invariant 6
    next = { ...block, input: squeezeInput(block.input, inputMode) };
    category = 'toolInputs';
  } else {
    // text and redacted_thinking are never touched.
    return none;
  }

  const saved = blockTokens(block) - blockTokens(next);
  return saved > 0 ? { block: next, category, saved } : none;
}

// tool_use id → tool name, over in-context entries. Lets a tool_result pick the
// right stub shape without a second scan.
function toolNamesById(objs: Array<PersistedLine | null | undefined>): Map<string, string> {
  const names = new Map<string, string>();
  for (const obj of objs) {
    if (obj?.isSidechain || obj?.type !== 'assistant') continue;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as WireContentBlock[]) {
      // id/name are strings in the CLI wire format; cast (not coerce) so a
      // malformed non-string still behaves exactly as before (truthy → kept).
      if (b?.type === 'tool_use' && b.id) names.set(b.id as string, b.name as string);
    }
  }
  return names;
}

// Cut a string at `max`, backing off one unit when that would land INSIDE a
// surrogate pair. `String.prototype.slice` counts UTF-16 code units, so a naive
// cut can leave a lone leading surrogate — an unpaired code unit with no valid
// UTF-8 encoding — which then gets written into the pruned jsonl and replayed
// into context on resume. Astral-plane characters (emoji, CJK ext, math script)
// turn up in exactly the values truncate mode targets: Edit old_string /
// new_string, Write content, Bash command.
//
// Only a trailing HIGH surrogate can be orphaned: if `value[end-1]` is a LOW
// surrogate its partner sits at `end-2`, already inside the cut.
function sliceCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  const end = (last >= 0xd800 && last <= 0xdbff) ? max - 1 : max;
  return value.slice(0, end);
}

// Squeeze one string value from a tool input. Returns the original when it is
// already short enough, so short scalars survive verbatim in both modes.
function squeezeString(value: string, mode: InputMode): string {
  if (mode === 'minimal') {
    // Whole-value replacement — no slicing, so surrogate-safe by construction.
    if (value.length <= MINIMAL_INPUT_MAX) return value;
    return `[pruned: ${humanBytes(Buffer.byteLength(value, 'utf8'))}]`;
  }
  if (value.length <= PRUNE_INPUT_MAX) return value;
  const head = sliceCodePoints(value, PRUNE_INPUT_MAX);
  return `${head}… [+${value.length - head.length} chars pruned]`;
}

// Walk a tool input, editing string VALUES in place and preserving every key,
// every nested object/array, and every non-string scalar. Path keys are skipped
// at any depth (invariant 1). Returns a new value; never mutates the input.
function squeezeInput(value: unknown, mode: InputMode, key: string | null = null): unknown {
  if (typeof value === 'string') {
    if (key !== null && PATH_KEYS.has(key)) return value;
    return squeezeString(value, mode);
  }
  if (Array.isArray(value)) return value.map(v => squeezeInput(v, mode, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = squeezeInput(v, mode, k);
    return out;
  }
  return value;
}

// ── analysis ────────────────────────────────────────────────────────────────

// Display-only (the slider's turn label), but cut the same surrogate-safe way —
// a lone high surrogate here would render as a replacement glyph.
function readTurnPreview(obj: PersistedLine | null | undefined): string {
  const content = obj?.type === 'attachment' ? obj.attachment?.prompt : obj?.message?.content;
  if (typeof content === 'string') return sliceCodePoints(content, 80);
  if (!Array.isArray(content)) return '';
  const text = (content as WireContentBlock[]).filter(b => b?.type === 'text')
    .map(b => b.text as string).join(' ');
  return sliceCodePoints(text.replace(/\s+/g, ' ').trim(), 80);
}

// The message-identity key for the unresolved-tool_use thinking exemption. Both
// sides of the set (build here, query in the callers) use this exact expression
// so add/has can never drift. Cast (not coerce) so a malformed non-string value
// keys the same way the original `??` did.
function thinkingExemptKey(obj: PersistedLine | null | undefined): string {
  return (obj?.message?.id ?? obj?.uuid) as string;
}

// An assistant entry whose thinking must NOT be touched: it carries a tool_use
// that never got a tool_result, so the next request continues a tool loop and the
// API validates the thinking signature against its content. The CLI splits one
// logical assistant message into N single-block lines sharing `message.id`, so the
// exemption is by message id, not by line.
function unresolvedThinkingMessageIds(objs: Array<PersistedLine | null | undefined>): Set<string> {
  const answered = new Set<string>();
  for (const obj of objs) {
    if (obj?.isSidechain) continue;
    const content = obj?.message?.content;
    if (obj?.type !== 'user' || !Array.isArray(content)) continue;
    for (const b of content as WireContentBlock[]) {
      if (b?.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id as string);
    }
  }
  const exempt = new Set<string>();
  for (const obj of objs) {
    if (obj?.isSidechain || obj?.type !== 'assistant') continue;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as WireContentBlock[]) {
      if (b?.type === 'tool_use' && b.id && !answered.has(b.id as string)) {
        exempt.add(thinkingExemptKey(obj));
      }
    }
  }
  return exempt;
}

// Parse the jsonl into `{ obj, raw, turn, prunable }` records. `turn` is the
// 0-based index among pure user-prompt lines — the SAME index space fork/rewind
// use (`isPureUserPromptLine`) and the same `userIndex` the conversation view
// stamps on user bubbles, which is what makes the slider snap to turn boundaries
// structurally rather than cosmetically. Lines before the first prompt ride turn 0.
async function readRecords({ cwd, sessionId }: { cwd: string; sessionId: string }): Promise<{
  file: string;
  records: Array<{ raw: string; obj: PersistedLine | null; turn: number; prunable: boolean; inContext: boolean }>;
  turnCount: number;
}> {
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') {
      throw httpError(404, `session ${sessionId} not found`);
    }
    throw e;
  }
  const records: Array<{ raw: string; obj: PersistedLine | null; turn: number; prunable: boolean; inContext: boolean }> = [];
  let turn = -1;
  for (const raw of text.split('\n')) {
    if (!raw.length) continue;
    let obj: PersistedLine | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') obj = parsed as PersistedLine;
    } catch { /* pass unparseable lines through verbatim */ }
    if (obj && isPureUserPromptLine(obj)) turn++;
    // Sidechain entries are not in the parent's context and are never pruned
    // (invariant 5); an unparseable line is copied byte-for-byte.
    const prunable = !!obj && !obj.isSidechain
      && (obj.type === 'assistant' || obj.type === 'user');
    // Wider than `prunable`: `attachment` entries (CLAUDE.md / nested-memory /
    // file injections the CLI folds into a user turn) ARE in the model's context
    // even though Prune never touches them. They belong in the savings
    // DENOMINATOR — leaving them out shrinks it and over-reports the percentage
    // saved, the same dishonesty we exclude sidechains to avoid, pointing the
    // other way. CLI bookkeeping lines (queue-operation, ai-title, last-prompt,
    // permission-mode, system) are not context and stay out.
    const inContext = prunable || (!!obj && !obj.isSidechain && obj.type === 'attachment');
    records.push({ raw, obj, turn: Math.max(turn, 0), prunable, inContext });
  }
  return { file, records, turnCount: turn + 1 };
}

// Per-turn, per-category savings. Savings are measured by running the ACTUAL stub
// functions and diffing the token estimate, so the preview can never drift from
// what the transform does.
//
// Counted over in-context entries ONLY: sidechain lines are skipped (a sub-agent's
// transcript is not in the parent's context — only the Task tool_result carrying
// its report is), and `toolUseResult` bytes are never counted (disk-only sidecar).
export async function analyzeSessionForPrune({ cwd, sessionId }: { cwd: string; sessionId: string }): Promise<{
  turnCount: number;
  turns: Array<{ index: number; preview: string; thinking: number; toolInputTruncatable: number; toolInputMinimal: number; toolOutput: number; total: number }>;
  totalTokens: number;
}> {
  if (!cwd || !sessionId) throw new Error('cwd + sessionId required');
  const { records, turnCount } = await readRecords({ cwd, sessionId });
  const exemptThinking = unresolvedThinkingMessageIds(records.map(r => r.obj));
  const toolNames = toolNamesById(records.map(r => r.obj));

  const turns = Array.from({ length: turnCount }, (_, index) => ({
    index, preview: '',
    thinking: 0, toolInputTruncatable: 0, toolInputMinimal: 0, toolOutput: 0, total: 0,
  }));
  let totalTokens = 0;

  for (const rec of records) {
    if (rec.obj && isPureUserPromptLine(rec.obj) && turns[rec.turn]) {
      turns[rec.turn].preview = readTurnPreview(rec.obj);
    }
    if (!rec.inContext) continue;
    if (!rec.prunable) {
      // An attachment: denominator only, never pruned. Its shape varies by
      // attachment kind, so estimate off the serialized payload.
      totalTokens += approxTokens(JSON.stringify(rec.obj?.attachment ?? ''));
      continue;
    }
    const content = rec.obj?.message?.content;
    if (!Array.isArray(content)) {
      if (typeof content === 'string') totalTokens += approxTokens(content);
      continue;
    }
    const bucket = turns[rec.turn];
    const exempt = exemptThinking.has(thinkingExemptKey(rec.obj));
    for (const block of content as PruneBlock[]) {
      const before = blockTokens(block);
      totalTokens += before;
      if (!bucket) continue;
      bucket.total += before;
      // Probe the real transform once per category. `inCut` is forced true here:
      // the analysis reports what EACH turn would yield if it fell inside the cut,
      // and the client sums the prefix the slider selects.
      const base = { inCut: true, exemptThinking: exempt, toolNames };
      const think = pruneBlock(block, { ...base, pruneThinking: true, inputMode: 'truncate' });
      const trunc = pruneBlock(block, { ...base, pruneThinking: false, inputMode: 'truncate' });
      const minimal = pruneBlock(block, { ...base, pruneThinking: false, inputMode: 'minimal' });
      if (think.category === 'thinking') bucket.thinking += think.saved;
      if (trunc.category === 'toolOutputs') bucket.toolOutput += trunc.saved;
      if (trunc.category === 'toolInputs') bucket.toolInputTruncatable += trunc.saved;
      if (minimal.category === 'toolInputs') bucket.toolInputMinimal += minimal.saved;
    }
  }
  return { turnCount, turns, totalTokens };
}

// ── the transform ───────────────────────────────────────────────────────────

async function writeAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}-${path.basename(file)}`);
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

// The CLI persists sub-agent transcripts in a sibling directory keyed by SESSION
// ID (`<encoded-cwd>/<sid>/subagents/agent-<agentId>.jsonl`, see
// transcript.ts:loadSubAgentTranscript). Minting a new sessionId would therefore
// make every sidechain silently vanish from the pruned session's transcript view
// — copy the directory across. Best-effort: a session with no sub-agents has none.
async function copySubAgentDir({ cwd, sessionId, newSessionId }: { cwd: string; sessionId: string; newSessionId: string }): Promise<void> {
  const base = path.join(claudeProjectsRoot(), encodeCwd(cwd));
  const src = path.join(base, sessionId);
  try { await fs.cp(src, path.join(base, newSessionId), { recursive: true }); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
}

// Copy <cwd>/<sessionId>.jsonl into a new sessionId, stubbing block content per
// the options. The original file is untouched.
//
//   cutTurnIndex — prune turns [0, cutTurnIndex). Must leave at least the newest
//                  turn verbatim, so the valid range is 0 … turnCount-1.
//   pruneThinking — global, independent of the cut (thinking staleness is
//                  categorical, not temporal), minus the unresolved-tool_use
//                  exemption.
//   inputMode    — 'truncate' | 'minimal', applied inside the pruned region only.
//
// Returns { newSessionId, saved:{thinking,toolInputs,toolOutputs}, lastSurvivingUuid }.
export async function pruneSessionToNewId({
  cwd, sessionId, cutTurnIndex, pruneThinking = false, inputMode = 'truncate',
  permissionMode, newSessionId,
}: {
  cwd: string; sessionId: string; cutTurnIndex: number;
  pruneThinking?: boolean; inputMode?: InputMode;
  permissionMode?: string; newSessionId?: string;
}): Promise<{ newSessionId: string; saved: { thinking: number; toolInputs: number; toolOutputs: number }; lastSurvivingUuid: string | null }> {
  if (!cwd || !sessionId) throw new Error('cwd + sessionId required');
  if (!INPUT_MODES.has(inputMode)) {
    throw httpError(400, `inputMode must be one of ${[...INPUT_MODES].join('|')}`);
  }
  const { records, turnCount } = await readRecords({ cwd, sessionId });
  if (turnCount === 0) {
    throw httpError(400, 'session has no user turns to prune');
  }
  if (!Number.isInteger(cutTurnIndex) || cutTurnIndex < 0 || cutTurnIndex > turnCount - 1) {
    throw httpError(400,
      `cutTurnIndex must be an integer in 0…${turnCount - 1} (the newest turn always stays verbatim)`);
  }

  const exemptThinking = unresolvedThinkingMessageIds(records.map(r => r.obj));
  const toolNames = toolNamesById(records.map(r => r.obj));
  const newSid = newSessionId ?? randomUUID();
  const saved = { thinking: 0, toolInputs: 0, toolOutputs: 0 };
  const out: string[] = [];
  let lastSurvivingUuid: string | null = null;

  for (const rec of records) {
    if (!rec.obj) { out.push(rec.raw); continue; }
    const obj = rec.obj;
    if (typeof obj.uuid === 'string') lastSurvivingUuid = obj.uuid;

    // Nothing to do for a line we never prune — but still rewrite sessionId so the
    // copy is self-consistent (the filename is what `--resume` reads; this keeps
    // downstream tooling honest, same as forkSessionAtUserMessage).
    const content = obj.message?.content;
    const inCut = rec.turn < cutTurnIndex;
    const touchable = rec.prunable && Array.isArray(content) && (inCut || pruneThinking);
    if (!touchable) {
      out.push(typeof obj.sessionId === 'string'
        ? JSON.stringify({ ...obj, sessionId: newSid })
        : rec.raw);
      continue;
    }

    const opts: PruneOpts = {
      inCut, pruneThinking, exemptThinking: exemptThinking.has(thinkingExemptKey(obj)), toolNames, inputMode,
    };
    const nextContent = (content as PruneBlock[]).map((block) => {
      const r = pruneBlock(block, opts);
      if (r.category) saved[r.category as keyof typeof saved] += r.saved;
      return r.block;
    });

    out.push(JSON.stringify({
      ...obj,
      ...(typeof obj.sessionId === 'string' ? { sessionId: newSid } : {}),
      message: { ...obj.message, content: nextContent },
    }));
  }

  await writeAtomic(
    path.join(claudeProjectsRoot(), encodeCwd(cwd), `${newSid}.jsonl`),
    out.join('\n') + '\n',
  );
  await copySubAgentDir({ cwd, sessionId, newSessionId: newSid });

  if (lastSurvivingUuid) {
    await writeSessionMetadata({
      cwd, sessionId: newSid,
      leafUuid: lastSurvivingUuid,
      permissionMode: permissionMode ?? 'bypassPermissions',
    });
  }

  return { newSessionId: newSid, saved, lastSurvivingUuid };
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

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
