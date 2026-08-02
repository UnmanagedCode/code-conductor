// Prune: deterministic, zero-token context compaction of a session jsonl.
//
// Copies a session's jsonl into a NEW sessionId, replacing the fat, low-value
// parts of the conversation — tool outputs, oversized tool inputs, thinking —
// with short stubs. No LLM pass: this is a mechanical file transform. The
// original file is never mutated (the caller archives it).
//
// Sibling of sessionEdit.js (rewind/fork) and shares its conventions: atomic
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
import { encodeCwd, claudeProjectsRoot } from './projects.js';
import { isPureUserPromptLine, writeSessionMetadata } from './transcript.js';

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
// (src/settings.js buildMcpConfigJSON), so every tool it exposes carries this
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
//   `input.questions` on replay (transcript.js), and the answer is recovered by
//   STRING-MATCHING the question text and option labels against the user echo
//   that follows (public/userQuestionAnswers.js, driven from
//   public/conversation.js). Squeezing either side leaves the human with an
//   unreadable question and silently drops the answer off the card.
//
//   Core conductor MCP calls: the orchestration record — what was spawned,
//   approved, merged, filed. Exempt as a NAMESPACE so a core tool added later is
//   exempt by default, minus PRUNABLE_CONDUCTOR_MCP_TOOLS.
//
// The segment count is load-bearing, NOT a plain prefix match: a plugin-forwarded
// tool (`…__code-kanban__file_task`) carries a further `__`, and plugin payloads
// are ordinary bulk output that stays prunable by default. Splitting on `__` and
// not `_` is what keeps a core tool whose own name contains an underscore —
// `spawn_instance`, `merge_worktree` — on the exempt side.
export function isPruneExemptTool(name) {
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

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Rough token estimate. Mirrors the shape of the CLI's own per-block accounting
// (text → text, thinking → thinking, tool_use → name + JSON(input), tool_result →
// content) at ~4 chars/token. The brief only asks for a heuristic; what matters is
// that it is computed over IN-CONTEXT entries only (see analyzeSessionForPrune).
const approxTokens = (s) => Math.ceil((s ?? '').length / 4);

function blockTokens(block) {
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return approxTokens(block.text);
    case 'thinking': return approxTokens(block.thinking);
    case 'redacted_thinking': return approxTokens(block.data);
    case 'tool_use': return approxTokens((block.name ?? '') + JSON.stringify(block.input ?? {}));
    case 'tool_result': return approxTokens(
      typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
    );
    default: return approxTokens(JSON.stringify(block));
  }
}

// ── the stubs ───────────────────────────────────────────────────────────────

// `toolName` is the name of the tool_use this result answers (null when unknown —
// e.g. an orphaned result), and decides the stub SHAPE. See PRUNE_STUB_AS_BLOCKS.
function stubToolResultContent(content, toolName) {
  const bytes = Buffer.byteLength(
    typeof content === 'string' ? content : JSON.stringify(content ?? ''), 'utf8',
  );
  const text = `[pruned: ${humanBytes(bytes)}]`;
  return PRUNE_STUB_AS_BLOCKS && SEEDING_TOOLS.has(toolName)
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
function pruneBlock(block, { inCut, pruneThinking, exemptThinking, toolNames, inputMode }) {
  const none = { block, category: null, saved: 0 };
  if (!block || typeof block !== 'object') return none;

  let next = null;
  let category = null;
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
    const toolName = toolNames.get(block.tool_use_id);
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
function toolNamesById(objs) {
  const names = new Map();
  for (const obj of objs) {
    if (obj?.isSidechain || obj?.type !== 'assistant') continue;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === 'tool_use' && b.id) names.set(b.id, b.name);
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
function sliceCodePoints(value, max) {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  const end = (last >= 0xd800 && last <= 0xdbff) ? max - 1 : max;
  return value.slice(0, end);
}

// Squeeze one string value from a tool input. Returns the original when it is
// already short enough, so short scalars survive verbatim in both modes.
function squeezeString(value, mode) {
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
function squeezeInput(value, mode, key = null) {
  if (typeof value === 'string') {
    if (key !== null && PATH_KEYS.has(key)) return value;
    return squeezeString(value, mode);
  }
  if (Array.isArray(value)) return value.map(v => squeezeInput(v, mode, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = squeezeInput(v, mode, k);
    return out;
  }
  return value;
}

// ── analysis ────────────────────────────────────────────────────────────────

// Display-only (the slider's turn label), but cut the same surrogate-safe way —
// a lone high surrogate here would render as a replacement glyph.
function readTurnPreview(obj) {
  const content = obj?.type === 'attachment' ? obj.attachment?.prompt : obj?.message?.content;
  if (typeof content === 'string') return sliceCodePoints(content, 80);
  if (!Array.isArray(content)) return '';
  const text = content.filter(b => b?.type === 'text').map(b => b.text).join(' ');
  return sliceCodePoints(text.replace(/\s+/g, ' ').trim(), 80);
}

// An assistant entry whose thinking must NOT be touched: it carries a tool_use
// that never got a tool_result, so the next request continues a tool loop and the
// API validates the thinking signature against its content. The CLI splits one
// logical assistant message into N single-block lines sharing `message.id`, so the
// exemption is by message id, not by line.
function unresolvedThinkingMessageIds(objs) {
  const answered = new Set();
  for (const obj of objs) {
    if (obj?.isSidechain) continue;
    const content = obj?.message?.content;
    if (obj?.type !== 'user' || !Array.isArray(content)) continue;
    for (const b of content) if (b?.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
  }
  const exempt = new Set();
  for (const obj of objs) {
    if (obj?.isSidechain || obj?.type !== 'assistant') continue;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use' && b.id && !answered.has(b.id)) {
        exempt.add(obj.message?.id ?? obj.uuid);
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
async function readRecords({ cwd, sessionId }) {
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      throw Object.assign(new Error(`session ${sessionId} not found`), { statusCode: 404 });
    }
    throw e;
  }
  const records = [];
  let turn = -1;
  for (const raw of text.split('\n')) {
    if (!raw.length) continue;
    let obj = null;
    try { obj = JSON.parse(raw); } catch { /* pass unparseable lines through verbatim */ }
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
export async function analyzeSessionForPrune({ cwd, sessionId }) {
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
      totalTokens += approxTokens(JSON.stringify(rec.obj.attachment ?? ''));
      continue;
    }
    const content = rec.obj.message?.content;
    if (!Array.isArray(content)) {
      if (typeof content === 'string') totalTokens += approxTokens(content);
      continue;
    }
    const bucket = turns[rec.turn];
    const exempt = exemptThinking.has(rec.obj.message?.id ?? rec.obj.uuid);
    for (const block of content) {
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

async function writeAtomic(file, content) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}-${path.basename(file)}`);
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

// The CLI persists sub-agent transcripts in a sibling directory keyed by SESSION
// ID (`<encoded-cwd>/<sid>/subagents/agent-<agentId>.jsonl`, see
// transcript.js:loadSubAgentTranscript). Minting a new sessionId would therefore
// make every sidechain silently vanish from the pruned session's transcript view
// — copy the directory across. Best-effort: a session with no sub-agents has none.
async function copySubAgentDir({ cwd, sessionId, newSessionId }) {
  const base = path.join(claudeProjectsRoot(), encodeCwd(cwd));
  const src = path.join(base, sessionId);
  try { await fs.cp(src, path.join(base, newSessionId), { recursive: true }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
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
}) {
  if (!cwd || !sessionId) throw new Error('cwd + sessionId required');
  if (!INPUT_MODES.has(inputMode)) {
    throw Object.assign(new Error(`inputMode must be one of ${[...INPUT_MODES].join('|')}`), { statusCode: 400 });
  }
  const { records, turnCount } = await readRecords({ cwd, sessionId });
  if (turnCount === 0) {
    throw Object.assign(new Error('session has no user turns to prune'), { statusCode: 400 });
  }
  if (!Number.isInteger(cutTurnIndex) || cutTurnIndex < 0 || cutTurnIndex > turnCount - 1) {
    throw Object.assign(
      new Error(`cutTurnIndex must be an integer in 0…${turnCount - 1} (the newest turn always stays verbatim)`),
      { statusCode: 400 },
    );
  }

  const exemptThinking = unresolvedThinkingMessageIds(records.map(r => r.obj));
  const toolNames = toolNamesById(records.map(r => r.obj));
  const newSid = newSessionId ?? randomUUID();
  const saved = { thinking: 0, toolInputs: 0, toolOutputs: 0 };
  const out = [];
  let lastSurvivingUuid = null;

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

    const msgId = obj.message?.id ?? obj.uuid;
    const opts = {
      inCut, pruneThinking, exemptThinking: exemptThinking.has(msgId), toolNames, inputMode,
    };
    const nextContent = content.map((block) => {
      const r = pruneBlock(block, opts);
      if (r.category) saved[r.category] += r.saved;
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
