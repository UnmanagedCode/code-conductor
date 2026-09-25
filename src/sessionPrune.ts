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
//   7. An image in a pruned turn never survives partially: a tool_result's stub
//      replaces its whole content, images included, and a top-level image
//      block becomes a text stub (content replaced, block kept — invariant 4).

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sessionFilePath, subAgentDirPath, writeFileAtomic, type TranscriptPlacement } from './projects.ts';
import { isPureUserPromptLine, writeSessionMetadata, type PersistedLine } from './transcript.ts';
import { promptTokenSum, type WireContentBlock } from './parser.ts';
import { httpError } from './httpError.ts';
import { imageDimensions, imageTokenCost, IMAGE_MAX_TOKENS } from './imageCost.ts';

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

// The core conductor tools that stay PRUNABLE. Their results are bulk file /
// command output — precisely what Prune exists to shed — where every other core
// tool's payload is orchestration record. Hardcoded rather than configurable:
// which class a tool is in is a property of the tool, not a user preference.
export const PRUNABLE_CONDUCTOR_MCP_TOOLS = new Set([
  `${CONDUCTOR_MCP_PREFIX}project_read`,
  `${CONDUCTOR_MCP_PREFIX}project_bash`,
  `${CONDUCTOR_MCP_PREFIX}system_bash`,
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
  source?: unknown;
  signature?: unknown;
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

// Characters per token, per block kind. Measured from Opus 5 usage deltas
// between consecutive calls: tool_result over steps whose only new content was
// one tool_result of at least 8k chars; text and tool_use (name + JSON(input))
// by least squares over every step. Tool output is denser than prose, which is
// why one flat ratio under-reports exactly what Prune removes. What these leave
// (a backend's own tokenizer, the session's mix) is corrected per session by
// usageCalibration.
export const TOKEN_CHARS = { text: 4.0, toolUse: 3.8, toolResult: 2.5 };

// Encrypted thinking (`thinking: ""` + a signature) is in context at about its
// `thinking_tokens`, and the signature grows linearly with them: a fixed
// overhead plus a per-token rate, fitted per model over empty-text blocks. The
// fit is for Opus 5 / Sonnet 5 / Opus 4.8; Opus 5.5 / Fable 5.1 signatures carry
// a larger fixed part, so their blocks are over-sized. That is accepted: this
// cost feeds calibration and the dialog's info row, never a saving (pruneBlock
// never rewrites an encrypted block).
const SIGNATURE_OVERHEAD_CHARS = 400;
const SIGNATURE_CHARS_PER_TOKEN = 3.6;

// The estimate is computed over IN-CONTEXT entries only (see
// analyzeSessionForPrune). Non-string input coerces to ''.
const approxTokens = (s: unknown, charsPerToken: number): number =>
  Math.ceil((typeof s === 'string' ? s : '').length / charsPerToken);

const isEncryptedThinking = (block: PruneBlock): boolean =>
  block.type === 'thinking' && (typeof block.thinking !== 'string' || block.thinking === '');

// A non-text block inside a tool_result's content array.
function nestedResultBlockTokens(block: unknown): number {
  return approxTokens(JSON.stringify(block), 4);
}

const isImage = (b: unknown): b is PruneBlock => !!b && typeof b === 'object' && (b as PruneBlock).type === 'image';

// Memoised per block object: the analysis costs the same block several times,
// and each would otherwise re-decode its base64.
const imageInfoCache = new WeakMap<object, { tokens: number; label: string }>();

// An image block's visual-token cost and its stub label. An image whose size
// cannot be read (a url/file source, an unrecognised header) is costed at the
// per-image budget — the most the API ever charges for one image — and never at
// its base64 length.
function imageInfo(block: PruneBlock): { tokens: number; label: string } {
  const cached = imageInfoCache.get(block);
  if (cached) return cached;
  const source = (block.source && typeof block.source === 'object' ? block.source : null) as
    { type?: unknown; media_type?: unknown; data?: unknown } | null;
  const mediaType = typeof source?.media_type === 'string' ? source.media_type : 'image';
  let info: { tokens: number; label: string };
  if (source?.type === 'base64' && typeof source.data === 'string') {
    const buf = Buffer.from(source.data, 'base64');
    const dims = imageDimensions(buf);
    info = dims
      ? { tokens: imageTokenCost(dims.width, dims.height), label: `${mediaType} ${dims.width}×${dims.height} (${humanBytes(buf.length)})` }
      : { tokens: IMAGE_MAX_TOKENS, label: `${mediaType} (${humanBytes(buf.length)})` };
  } else {
    info = { tokens: IMAGE_MAX_TOKENS, label: `${mediaType} (${String(source?.type ?? 'no source')})` };
  }
  imageInfoCache.set(block, info);
  return info;
}

function blockTokens(block: PruneBlock | null | undefined): number {
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return approxTokens(block.text, TOKEN_CHARS.text);
    case 'thinking': {
      // A visible-thinking model's text is what is in context; its signature is not.
      if (!isEncryptedThinking(block)) return approxTokens(block.thinking, TOKEN_CHARS.text);
      const sig = typeof block.signature === 'string' ? block.signature.length : 0;
      return Math.max(0, Math.ceil((sig - SIGNATURE_OVERHEAD_CHARS) / SIGNATURE_CHARS_PER_TOKEN));
    }
    case 'redacted_thinking': return approxTokens(block.data, 4);
    case 'tool_use': return approxTokens(String(block.name ?? '') + JSON.stringify(block.input ?? {}), TOKEN_CHARS.toolUse);
    // An image's visual-token cost comes from its dimensions, never a chars ratio.
    case 'image': return imageInfo(block).tokens;
    case 'tool_result': {
      if (!Array.isArray(block.content)) {
        return approxTokens(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''), TOKEN_CHARS.toolResult);
      }
      let textChars = 0;
      let nested = 0;
      for (const b of block.content as PruneBlock[]) {
        if (b?.type === 'text' && typeof b.text === 'string') textChars += b.text.length;
        else if (isImage(b)) nested += imageInfo(b).tokens;
        else nested += nestedResultBlockTokens(b);
      }
      return Math.ceil(textChars / TOKEN_CHARS.toolResult) + nested;
    }
    default: return approxTokens(JSON.stringify(block), 4);
  }
}

// ── the stubs ───────────────────────────────────────────────────────────────

// `toolName` is the name of the tool_use this result answers (null when unknown —
// e.g. an orphaned result), and decides the stub SHAPE. See PRUNE_STUB_AS_BLOCKS.
// The stub names the non-image bytes it replaced and each image by label.
function stubToolResultContent(content: unknown, toolName: string | undefined): Array<{ type: string; text: string }> | string {
  const images = Array.isArray(content) ? content.filter(isImage) : [];
  const rest = Array.isArray(content) && images.length ? content.filter(b => !isImage(b)) : null;
  const parts: string[] = [];
  if (!rest || rest.length) {
    const serialized = rest ? JSON.stringify(rest)
      : typeof content === 'string' ? content : JSON.stringify(content ?? '');
    parts.push(humanBytes(Buffer.byteLength(serialized, 'utf8')));
  }
  for (const img of images) parts.push(imageInfo(img).label);
  const text = `[pruned: ${parts.join('; ')}]`;
  return PRUNE_STUB_AS_BLOCKS && toolName != null && SEEDING_TOOLS.has(toolName)
    ? [{ type: 'text', text }]
    : text;
}

// THE single block transform — both the savings preview and the actual rewrite
// call this, so the number the dialog shows can never drift from what Prune does.
//
// Returns { block, category, saved, imageSaved }. `saved` is the token delta and
// is never negative: a stub that would be BIGGER than what it replaces (an empty
// thinking block, a two-byte tool output) is skipped and the original block is
// returned verbatim. Pruning must never inflate the context.
//
// `imageSaved` is the part of `saved` owed to images, whose cost is real (the
// patch rule), not an estimate — so the calibration factor must not scale it.
// The rule: the stub's whole cost is charged to the block's images. The image
// part is the images' cost less the stub's, floored at 0 and capped at `saved`;
// the rest of `saved` is the non-image content's full estimate.
function pruneBlock(block: PruneBlock | null | undefined, { inCut, pruneThinking, exemptThinking, toolNames, inputMode }: PruneOpts): {
  block: PruneBlock | null | undefined; category: string | null; saved: number; imageSaved: number;
} {
  const none = { block, category: null, saved: 0, imageSaved: 0 };
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
    // Encrypted thinking has a cost (blockTokens sizes it from the signature),
    // so the stub would score a saving — but the text is already empty: the
    // rewrite would remove nothing and put a stub beside a signature that
    // covers the real, hidden thinking.
    if (isEncryptedThinking(block)) return none;
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
  } else if (block.type === 'image') {
    // A user-pasted image (invariant 7). Folded into tool outputs: top-level
    // images only arise in adopted terminal-CLI sessions.
    next = { type: 'text', text: `[pruned: ${imageInfo(block).label}]` };
    category = 'toolOutputs';
  } else {
    // text and redacted_thinking are never touched.
    return none;
  }

  const saved = blockTokens(block) - blockTokens(next);
  if (saved <= 0) return none;
  const imageTokens = block.type === 'image' ? imageInfo(block).tokens
    : block.type === 'tool_result' && Array.isArray(block.content)
      ? (block.content as unknown[]).filter(isImage).reduce((n, b) => n + imageInfo(b).tokens, 0)
      : 0;
  const imageSaved = imageTokens > 0 ? Math.max(0, Math.min(saved, imageTokens - blockTokens(next))) : 0;
  return { block: next, category, saved, imageSaved };
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

// Matches every stub this module writes: THINKING_STUB, the truncation suffix,
// and every `[pruned: …]` marker — a size (squeezeString, stubToolResultContent),
// or one ending in an image label's parenthesis (a top-level image, a tool_result
// that held images). Tested against a block's JSON, so it finds a stub at any depth.
const PRUNE_STUB_RE = /\[pruned: (?:thinking|[^\]\n]*(?:\d B|KB|MB|\)))\]|… \[\+\d+ chars pruned\]/;

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

interface PruneRecord { raw: string; obj: PersistedLine | null; turn: number; prunable: boolean; inContext: boolean }

// Parse the jsonl into `{ obj, raw, turn, prunable }` records. `turn` is the
// 0-based index among pure user-prompt lines — the SAME index space fork/rewind
// use (`isPureUserPromptLine`) and the same `userIndex` the conversation view
// stamps on user bubbles, which is what makes the slider snap to turn boundaries
// structurally rather than cosmetically. Lines before the first prompt ride turn 0.
//
// Everything before the LAST compaction boundary has left the model's context:
// neither prunable nor in context, so no estimate counts it and the transform
// copies it verbatim. The CLI also carries a few pre-boundary messages across a
// compaction (`compactMetadata.preservedMessages`); they are not counted either,
// so a session that keeps them under-reports slightly.
async function readRecords({ place, sessionId }: { place: TranscriptPlacement; sessionId: string }): Promise<{
  file: string;
  records: PruneRecord[];
  turnCount: number;
}> {
  const file = sessionFilePath(place, sessionId);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') {
      throw httpError(404, `session ${sessionId} not found`);
    }
    throw e;
  }
  const parsed: Array<{ raw: string; obj: PersistedLine | null }> = [];
  for (const raw of text.split('\n')) {
    if (!raw.length) continue;
    let obj: PersistedLine | null = null;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object') obj = value as PersistedLine;
    } catch { /* pass unparseable lines through verbatim */ }
    parsed.push({ raw, obj });
  }
  let boundary = -1;
  parsed.forEach(({ obj }, i) => {
    if (obj && !obj.isSidechain && obj.type === 'system' && obj.subtype === 'compact_boundary') boundary = i;
  });

  const records: PruneRecord[] = [];
  let turn = -1;
  for (const [i, { raw, obj }] of parsed.entries()) {
    if (obj && isPureUserPromptLine(obj)) turn++;
    const live = i > boundary;
    // Sidechain entries are not in the parent's context and are never pruned
    // (invariant 5); an unparseable line is copied byte-for-byte.
    const prunable = live && !!obj && !obj.isSidechain
      && (obj.type === 'assistant' || obj.type === 'user');
    // Wider than `prunable`: `attachment` entries (CLAUDE.md / nested-memory /
    // file injections the CLI folds into a user turn) ARE in the model's context
    // even though Prune never touches them — usageCalibration reads them to
    // decide which steps it can measure. CLI bookkeeping lines (queue-operation,
    // ai-title, last-prompt, permission-mode, system) are not context.
    const inContext = prunable || (live && !!obj && !obj.isSidechain && obj.type === 'attachment');
    records.push({ raw, obj, turn: Math.max(turn, 0), prunable, inContext });
  }
  return { file, records, turnCount: turn + 1 };
}

// ── calibration ─────────────────────────────────────────────────────────────

// Attachment kinds the CLI emits on (nearly) every step, whose context cost is
// part of the per-step framing the calibration absorbs. Any other attachment
// kind makes its step unmeasurable. CLI-owned vocabulary, read as found.
const PER_STEP_ATTACHMENTS = new Set(['total_tokens_reminder', 'hook_success']);

// Below this much estimated growth the measured factor is noise; use 1.
const CALIBRATION_MIN_TOKENS = 5000;
const CALIBRATION_MIN_FACTOR = 0.5;
const CALIBRATION_MAX_FACTOR = 2;

// Content the estimate cannot size the way the API counts it: images, redacted
// thinking, and a stub from an earlier prune (whose step's recorded usage still
// reflects the content the stub replaced).
function unmeasurableBlock(block: PruneBlock | null | undefined): boolean {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'image' || block.type === 'redacted_thinking') return true;
  if (block.type === 'tool_result' && Array.isArray(block.content)
    && (block.content as PruneBlock[]).some(b => b?.type === 'image')) return true;
  return PRUNE_STUB_RE.test(JSON.stringify(block));
}

// The session's measured-over-estimated token ratio. Both the analysis and the
// transform scale by it, so the preview and the reported saving stay equal.
//
// A CALL is an in-context assistant message carrying real usage; the CLI splits
// one message over several lines sharing its id and usage, so a call starts at
// the first line of a new id. A STEP runs from one call's first line to the
// next call's: the prompt grew by exactly the content appended in between, so
// its measured growth is the next prompt minus this one, and its estimate is
// blockTokens over its in-context user/assistant content (attachments are not
// estimated). A step is dropped when it holds unmeasurable content, an attachment
// outside PER_STEP_ATTACHMENTS, or did not grow (a prune or compaction drop).
//
// `calibrated` is false when too little growth was measured and the factor fell
// back to 1; `steps` is reported either way. A clamped factor is calibrated.
function usageCalibration(records: PruneRecord[]): { factor: number; steps: number; calibrated: boolean } {
  let prevPrompt: number | null = null;
  let prevId: unknown;
  let est = 0;
  let usable = true;
  let sumReal = 0;
  let sumEst = 0;
  let steps = 0;
  for (const rec of records) {
    if (!rec.inContext || !rec.obj) continue;
    const obj = rec.obj;
    const msg = obj.message;
    if (obj.type === 'assistant' && msg?.usage != null && msg.model !== '<synthetic>'
      && promptTokenSum(msg.usage) > 0 && msg.id !== prevId) {
      const promptNow = promptTokenSum(msg.usage);
      if (prevPrompt !== null && usable && promptNow > prevPrompt) {
        sumReal += promptNow - prevPrompt;
        sumEst += est;
        steps++;
      }
      prevPrompt = promptNow;
      prevId = msg.id;
      est = 0;
      usable = true;
    }
    if (!rec.prunable) {
      if (!PER_STEP_ATTACHMENTS.has(obj.attachment?.type as string)) usable = false;
      continue;
    }
    const content = msg?.content;
    if (typeof content === 'string') est += approxTokens(content, TOKEN_CHARS.text);
    if (!Array.isArray(content)) continue;
    for (const block of content as PruneBlock[]) {
      if (unmeasurableBlock(block)) usable = false;
      est += blockTokens(block);
    }
  }
  if (sumEst < CALIBRATION_MIN_TOKENS) return { factor: 1, steps, calibrated: false };
  const factor = Math.min(CALIBRATION_MAX_FACTOR, Math.max(CALIBRATION_MIN_FACTOR, sumReal / sumEst));
  return { factor, steps, calibrated: true };
}

// The ctx chip's reading (public/usage.js currentContextSize) for a latched
// usage object, or null when there is none — the real baseline both the
// analysis route and prune_session report beside the estimate.
export function contextReading(usage: unknown): number | null {
  if (!usage) return null;
  return promptTokenSum(usage) || null;
}

// Per-turn, per-category savings. Savings are measured by running the ACTUAL stub
// functions and diffing the token estimate, so the preview can never drift from
// what the transform does.
//
// Counted over in-context entries ONLY: sidechain lines are skipped (a sub-agent's
// transcript is not in the parent's context — only the Task tool_result carrying
// its report is), and `toolUseResult` bytes are never counted (disk-only sidecar).
//
// Every per-turn figure is RAW (uncalibrated); the client scales its sums by
// `calibration.factor` exactly as pruneSessionToNewId scales `saved`.
// `toolOutputImage` is the part of `toolOutput` owed to images (see pruneBlock),
// which is added back unscaled.
// `exempt` is the in-context payload of exempt tools (isPruneExemptTool) — kept,
// never saved. `encryptedThinking` is session-wide, like thinking pruning.
export async function analyzeSessionForPrune({ place, sessionId }: { place: TranscriptPlacement; sessionId: string }): Promise<{
  turnCount: number;
  turns: Array<{ index: number; preview: string; thinking: number; toolInputTruncatable: number; toolInputMinimal: number; toolOutput: number; toolOutputImage: number; exempt: number; total: number }>;
  encryptedThinking: number;
  calibration: { factor: number; steps: number; calibrated: boolean };
}> {
  if (!place?.cwd || !sessionId) throw new Error('place + sessionId required');
  const { records, turnCount } = await readRecords({ place, sessionId });
  const exemptThinking = unresolvedThinkingMessageIds(records.map(r => r.obj));
  const toolNames = toolNamesById(records.map(r => r.obj));

  const turns = Array.from({ length: turnCount }, (_, index) => ({
    index, preview: '',
    thinking: 0, toolInputTruncatable: 0, toolInputMinimal: 0, toolOutput: 0, toolOutputImage: 0, exempt: 0, total: 0,
  }));
  let encryptedThinking = 0;

  for (const rec of records) {
    if (rec.obj && isPureUserPromptLine(rec.obj) && turns[rec.turn]) {
      turns[rec.turn].preview = readTurnPreview(rec.obj);
    }
    if (!rec.prunable) continue;
    const content = rec.obj?.message?.content;
    if (!Array.isArray(content)) continue;
    const bucket = turns[rec.turn];
    const exempt = exemptThinking.has(thinkingExemptKey(rec.obj));
    for (const block of content as PruneBlock[]) {
      const before = blockTokens(block);
      if (block && typeof block === 'object' && isEncryptedThinking(block)) encryptedThinking += before;
      if (!bucket) continue;
      bucket.total += before;
      const exemptName = block?.type === 'tool_use' ? block.name
        : block?.type === 'tool_result' ? toolNames.get(block.tool_use_id as string) : undefined;
      if (isPruneExemptTool(exemptName)) bucket.exempt += before;
      // Probe the real transform once per category. `inCut` is forced true here:
      // the analysis reports what EACH turn would yield if it fell inside the cut,
      // and the client sums the prefix the slider selects.
      const base = { inCut: true, exemptThinking: exempt, toolNames };
      const think = pruneBlock(block, { ...base, pruneThinking: true, inputMode: 'truncate' });
      const trunc = pruneBlock(block, { ...base, pruneThinking: false, inputMode: 'truncate' });
      const minimal = pruneBlock(block, { ...base, pruneThinking: false, inputMode: 'minimal' });
      if (think.category === 'thinking') bucket.thinking += think.saved;
      if (trunc.category === 'toolOutputs') {
        bucket.toolOutput += trunc.saved;
        bucket.toolOutputImage += trunc.imageSaved;
      }
      if (trunc.category === 'toolInputs') bucket.toolInputTruncatable += trunc.saved;
      if (minimal.category === 'toolInputs') bucket.toolInputMinimal += minimal.saved;
    }
  }
  return { turnCount, turns, encryptedThinking, calibration: usageCalibration(records) };
}

// ── the transform ───────────────────────────────────────────────────────────

// The CLI persists sub-agent transcripts in a sibling directory keyed by SESSION
// ID (`<encoded-cwd>/<sid>/subagents/agent-<agentId>.jsonl`, see
// transcript.ts:loadSubAgentTranscript). Minting a new sessionId would therefore
// make every sidechain silently vanish from the pruned session's transcript view
// — copy the directory across. Best-effort: a session with no sub-agents has none.
async function copySubAgentDir({ place, sessionId, newSessionId }: { place: TranscriptPlacement; sessionId: string; newSessionId: string }): Promise<void> {
  const src = subAgentDirPath(place, sessionId);
  try { await fs.cp(src, subAgentDirPath(place, newSessionId), { recursive: true }); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
}

// Copy <cwd>/<sessionId>.jsonl into a new sessionId, stubbing block content per
// the options. The original file is untouched.
//
//   cutTurnIndex — prune turns [0, cutTurnIndex). Valid range 0 … turnCount, so
//                  a full cut (every turn, newest included) is expressible.
//   keepLatestTurns — the relative spelling of the same cut: leave that many of
//                  the newest turns verbatim, 0 for a full cut. Resolved HERE,
//                  against the turn count read below, because that is the only
//                  point past the subprocess kill — a caller that pre-read the
//                  count could have a turn land in between and silently keep one
//                  turn too many. Exactly one of the two must be supplied.
//   pruneThinking — global, independent of the cut (thinking staleness is
//                  categorical, not temporal), minus the unresolved-tool_use
//                  exemption.
//   inputMode    — 'truncate' | 'minimal', applied inside the pruned region only.
//
// Returns { newSessionId, turnCount, cutTurnIndex, saved:{…}, lastSurvivingUuid }.
// `saved` is calibrated: each category's raw non-image estimate × usageCalibration's
// factor, plus its image part unscaled (see pruneBlock).
export async function pruneSessionToNewId({
  place, sessionId, cutTurnIndex, keepLatestTurns, pruneThinking = false, inputMode = 'truncate',
  mode, newSessionId,
}: {
  place: TranscriptPlacement; sessionId: string; cutTurnIndex?: number; keepLatestTurns?: number;
  pruneThinking?: boolean; inputMode?: InputMode;
  mode: string; newSessionId?: string;
}): Promise<{
  newSessionId: string; turnCount: number; cutTurnIndex: number;
  saved: { thinking: number; toolInputs: number; toolOutputs: number }; lastSurvivingUuid: string | null;
}> {
  if (!place?.cwd || !sessionId) throw new Error('place + sessionId required');
  if (!INPUT_MODES.has(inputMode)) {
    throw httpError(400, `inputMode must be one of ${[...INPUT_MODES].join('|')}`);
  }
  // XOR, not a precedence rule: two cut specifications that disagree is a caller
  // bug, and silently honouring one of them prunes the wrong amount of context.
  if ((cutTurnIndex === undefined) === (keepLatestTurns === undefined)) {
    throw httpError(400, 'supply exactly one of cutTurnIndex or keepLatestTurns');
  }
  if (keepLatestTurns !== undefined && (!Number.isInteger(keepLatestTurns) || keepLatestTurns < 0)) {
    throw httpError(400, 'keepLatestTurns must be a non-negative integer');
  }
  const { records, turnCount } = await readRecords({ place, sessionId });
  if (turnCount === 0) {
    throw httpError(400, 'session has no user turns to prune');
  }
  // Clamping (rather than rejecting) an oversized keepLatestTurns is what makes
  // "keep more turns than the session has" mean "prune nothing".
  const cut = cutTurnIndex ?? Math.max(0, turnCount - (keepLatestTurns as number));
  if (!Number.isInteger(cut) || cut < 0 || cut > turnCount) {
    throw httpError(400, `cutTurnIndex must be an integer in 0…${turnCount}`);
  }

  const exemptThinking = unresolvedThinkingMessageIds(records.map(r => r.obj));
  const toolNames = toolNamesById(records.map(r => r.obj));
  const newSid = newSessionId ?? randomUUID();
  const saved = { thinking: 0, toolInputs: 0, toolOutputs: 0 };
  const imageSaved = { thinking: 0, toolInputs: 0, toolOutputs: 0 };
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
    const inCut = rec.turn < cut;
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
      if (r.category) {
        saved[r.category as keyof typeof saved] += r.saved;
        imageSaved[r.category as keyof typeof saved] += r.imageSaved;
      }
      return r.block;
    });

    out.push(JSON.stringify({
      ...obj,
      ...(typeof obj.sessionId === 'string' ? { sessionId: newSid } : {}),
      message: { ...obj.message, content: nextContent },
    }));
  }

  const { factor } = usageCalibration(records);
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) {
    saved[k] = Math.round((saved[k] - imageSaved[k]) * factor) + imageSaved[k];
  }

  await writeFileAtomic(sessionFilePath(place, newSid), out.join('\n') + '\n');
  await copySubAgentDir({ place, sessionId, newSessionId: newSid });

  if (lastSurvivingUuid) {
    await writeSessionMetadata({
      place, sessionId: newSid,
      leafUuid: lastSurvivingUuid,
      mode,
    });
  }

  return { newSessionId: newSid, turnCount, cutTurnIndex: cut, saved, lastSurvivingUuid };
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

