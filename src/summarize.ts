// One-shot session summarization via `claude -p --output-format=json`.
// No in-process fetch — outbound DNS is broken on this host; the CLI
// handles all networking.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionFilePath, orchStoreRoot, findSessionLocation } from './projects.ts'; // sessionFilePath used by countMessages/flattenTranscript
import { resolveClaudeBin, resolveBackendLaunch } from './claudeLauncher.ts';
import { getTierBackend, getBackend } from './appSettings.ts';
import { CLAUDE_BACKEND_ID } from './modelVersions.ts';
import { SUMMARY_LENGTHS, type SummaryLength } from './sessionSummaries.ts';
import { httpError } from './httpError.ts';

// Dedicated cwd for one-shot summary subprocesses: a subdirectory inside
// the .code-conductor metadata dir. It is NOT under PROJECTS_ROOT as a
// named project, so the CLI's session jsonl for the one-shot call lands
// in an isolated encoded dir that never appears in the conductor sidebar.
// We do NOT delete those jsonls — they are harmless litter in an opaque
// metadata dir, and reaching into ~/.claude/projects/ to delete them is
// fragile. Exported so tests can introspect the expected spawn cwd.
export function summarySpawnDir(): string {
  return path.join(orchStoreRoot(), 'summaries');
}

const LENGTH_INSTRUCTIONS: Record<'short' | 'medium' | 'long', { depth: string; budget: string; structure: string }> = {
  short: {
    depth: 'a one-glance gist — just what the session was about and the outcome. Highest altitude.',
    budget: '~40 content words maximum',
    structure: 'Plain prose only — no headings, bullets, or tables at this size.',
  },
  medium: {
    depth: 'a scannable recap of the essentials — the goal, the main changes, key decisions, and the outcome. Compact but complete.',
    budget: '~150 content words maximum',
    structure: 'Use bullets or a table for any enumerable information (list of changes, decisions, files). Reserve flowing prose for narrative or rationale. One or two short headings are fine if they help, but don\'t over-structure.',
  },
  long: {
    depth: 'a thorough recap — cover all notable changes, decisions, and outcomes in detail.',
    budget: '~400 content words maximum',
    structure: 'Lean heavily on markdown structure: ## section headings, bullet lists, and tables for enumerable information (commits, files changed, decisions, test results). Reserve prose for narrative and rationale. A table is better than a run-on sentence for any list of three or more items.',
  },
};

const INPUT_CAP = 80_000;
const INPUT_HEAD = 20_000;
const INPUT_TAIL = 60_000;

// Generation cap. Not unbounded: this one-shot spawn isn't tracked by
// instances.ts's registry, so nothing kills it on server shutdown or a
// disconnected client — a wedged child would otherwise hang forever.
// The REAL governing bound on this path is Node's http.Server default
// requestTimeout (300_000ms — server.ts sets no override), which ends the
// whole request-response cycle regardless of this timer. Staying under it
// means our own timer always fires first, so a summary can never persist
// after the client has already seen the request fail.
const GENERATION_TIMEOUT_MS = 290_000;

// A persisted session line narrowed to the fields flattenTranscript/countMessages read.
interface TranscriptLine {
  type?: unknown;
  message?: { content?: unknown } | null;
}

// Read the session jsonl and return { conversationText, messageCount }.
// messageCount = number of type:'user' + type:'assistant' lines.
// conversationText is formatted as "User: ...\nAssistant: ...\n\n" turns,
// capped at INPUT_CAP chars.
export async function flattenTranscript(sessionId: string, cwd: string): Promise<{ conversationText: string; messageCount: number }> {
  const file = sessionFilePath(cwd, sessionId);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') throw Object.assign(new Error(`session not found: ${sessionId}`), { code: 'ENOENT' });
    throw e;
  }

  const turns: string[] = [];
  let messageCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: TranscriptLine | null = null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') obj = parsed as TranscriptLine;
    } catch { continue; }
    if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) continue;

    messageCount++;
    const content = obj.message?.content;
    if (!content) continue;

    // Extract only text blocks; skip tool_use / tool_result entirely.
    const texts: string[] = [];
    if (typeof content === 'string') {
      if (content.trim()) texts.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text.trim());
        }
      }
    }

    if (texts.length === 0) continue;
    const label = obj.type === 'user' ? 'User' : 'Assistant';
    turns.push(`${label}: ${texts.join('\n')}`);
  }

  let conversationText = turns.join('\n\n');

  if (conversationText.length > INPUT_CAP) {
    const head = conversationText.slice(0, INPUT_HEAD);
    const tail = conversationText.slice(-INPUT_TAIL);
    conversationText = `${head}\n\n[...middle truncated...]\n\n${tail}`;
  }

  return { conversationText, messageCount };
}

// Count user+assistant message lines in a session jsonl. Used by the GET
// summary endpoint to detect staleness without loading the full transcript.
// Returns 0 if the file is missing (archived/deleted session).
export async function countMessages(sessionId: string, cwd: string): Promise<number> {
  const file = sessionFilePath(cwd, sessionId);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) { if (errCode(e) === 'ENOENT') return 0; throw e; }
  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: TranscriptLine | null = null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') obj = parsed as TranscriptLine;
    } catch { continue; }
    if (obj && (obj.type === 'user' || obj.type === 'assistant')) count++;
  }
  return count;
}

// The `claude -p --output-format=json` result envelope (loose — CLI-owned).
interface SummaryOutput {
  result?: unknown;
  total_cost_usd?: unknown;
  cost_usd?: unknown;
}

// The existing tier-summary template, verbatim.
function summaryPrompt(tier: { depth: string; budget: string; structure: string }, conversationText: string): string {
  return `Summarize the following Claude Code session.

Coverage: ${tier.depth}
Word budget: ${tier.budget} of CONTENT words.

Focus on: what the user wanted to accomplish, what was built or changed, key decisions made. Skip tool call details; describe outcomes and results.

${tier.structure}

Critical word-count rule: the word budget counts CONTENT words only — the actual words of information you write. Markdown scaffolding (#, ##, |, -, *, ** markers, table pipes and dashes) does NOT count toward the budget. Judge your length by the informational words, not the formatting. A compact table with 30 content words is not "over budget" because of its pipes. This means: use markdown structure freely to improve scannability; only the substance counts.

CONVERSATION:
${conversationText}
---
Provide the summary only, no preamble:`;
}

// Names the session's CURRENT end goal, not a recap. Prefixed with the
// project the session concerns, e.g. "code-conductor: Add cost readout to
// the summary dialog". The project name comes from the CONVERSATION, not the
// filesystem: a conductor session's own cwd is the orchestrator's hidden
// `.conduct` project, but the session is almost always orchestrating some
// OTHER project named in the transcript (paths it touches, workers it spawns
// into, repos it discusses) — cwd-derived resolution would just be wrong for
// exactly the sessions this feature matters most for. `projectHint`, when
// given (see projectNameHint), is passed as a fallback the model may use
// only when the conversation itself is ambiguous — it never overrides what
// the conversation says.
function titlePrompt(conversationText: string, projectHint: string | null): string {
  return `Name the CURRENT end goal of the following Claude Code session.

This is not a recap. Work that is already finished matters only as context: say what the session is trying to achieve RIGHT NOW — the objective the most recent turns are working toward. If the goal changed mid-session, the latest one wins. If the latest turns are verifying or fixing up earlier work, that clean-up IS the current goal.

First, determine which PROJECT this session concerns, from the conversation itself: the projects it spawns workers into, the paths and repos it operates on or discusses. If it touches several, name the one the CURRENT goal concerns. This may be an orchestrator/conductor session whose own working directory is not a project at all — never output "conduct" or ".conduct" as the project name; a conductor session is always actually about some OTHER project named somewhere in the conversation.${projectHint ? ` Hint only, derived from the session's checkout path, to use if the conversation itself is ambiguous — it does NOT override what the conversation says: "${projectHint}".` : ''}

If you identified a project: output exactly one line in the form "<Project>: <title>" — the project name, a colon, a space, then the title. The WHOLE line, project name included, must be at most 100 characters — this is a hard limit. Aim for the <title> part alone (not counting the "<Project>: " prefix) to be around 60 characters, but if the project name is long enough that "<Project>: " plus a 60-character title would exceed 100 characters total, shorten the <title> part to fit — never shorten, abbreviate, or drop the project name to make room.
If you could not identify any project: output just the title on its own, at most 60 characters total — no prefix, no colon, no invented project name.

Either way, the title itself: plain text only, no markdown, no surrounding quotes, no trailing period, no "Session:" or "Title:" prefix, no explanation before or after. Sentence case. Prefer a concrete noun phrase naming the thing being built, fixed, or investigated, never a vague category ("Code improvements").

CONVERSATION:
${conversationText}
---
Provide the title line only, no preamble:`;
}

// Best-effort HINT for the title prompt: the project a session's checkout
// path belongs to, worktree-aware (`cwd` may be `<project>_worktree_<id>`,
// whose directory name is NOT the project name — findSessionLocation already
// solves this; it's the same lookup routes.ts used to resolve `cwd` from
// `sessionId` in the first place, so reuse it rather than parsing `cwd`).
// Returns null (no hint) when the session can't be located, or when it
// resolves to the hidden `.conduct` conductor project — that's never a real
// project name, so it must never even reach the prompt as a hint.
async function projectNameHint(sessionId: string): Promise<string | null> {
  const hit = await findSessionLocation(sessionId).catch(() => null);
  return hit && hit.project !== '.conduct' ? hit.project : null;
}

// Generate a summary (or title) of a session by running `claude -p` as a
// one-shot subprocess. Returns { summary, messageCount, durationMs, costUsd }.
export async function generateSummary(sessionId: string, cwd: string, length: SummaryLength = 'medium'): Promise<{ summary: string; messageCount: number; durationMs: number; costUsd: number | null }> {
  if (!(SUMMARY_LENGTHS as readonly string[]).includes(length)) {
    throw httpError(400, `invalid length: ${length}`);
  }

  const { conversationText, messageCount } = await flattenTranscript(sessionId, cwd);
  const prompt = length === 'title'
    ? titlePrompt(conversationText, await projectNameHint(sessionId))
    : summaryPrompt(LENGTH_INSTRUCTIONS[length], conversationText);

  // Honor the fast tier's bound backend unconditionally — same reasoning as
  // claudeShellEnv.ts's generateBundle(): no Anthropic fallback, since a host
  // with no Claude access wouldn't have that model. A substitution backend
  // re-execs the SAME claude binary (only the endpoint/auth differ), so
  // --output-format=json's result envelope is unaffected; a missing cost there
  // already falls through the `?? null` below.
  const fastBackend = getTierBackend('fast');
  const { command, prefixArgs, env: backendEnvVars } =
    resolveBackendLaunch(getBackend(fastBackend.backend), fastBackend.model, resolveClaudeBin());
  // Throwaway session-id so each generation is independent (no accidental
  // resume of a prior one-shot call).
  const scratchId = randomUUID();
  const args = [
    ...prefixArgs,
    '-p',
    '--output-format=json',
    '--model', fastBackend.model,
    '--session-id', scratchId,
  ];

  // Use a subdir inside the .code-conductor metadata dir as the spawn cwd.
  // That path is not listed as a project under PROJECTS_ROOT, so the CLI's
  // session jsonl never surfaces in the conductor sidebar.
  const spawnDir = summarySpawnDir();
  await fs.mkdir(spawnDir, { recursive: true });

  const startMs = Date.now();

  const parsed = await new Promise<SummaryOutput>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: spawnDir,
      env: { ...process.env, ...backendEnvVars },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`summary generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s`));
    }, GENERATION_TIMEOUT_MS);

    // A spawn that never starts (ENOENT/EACCES — e.g. a backend template naming a
    // command that isn't installed) emits 'error', never 'close'. Without this
    // listener the EventEmitter default rethrows it as an uncaught exception and
    // takes the whole server down with every live session. Mirrors the same guard
    // in claudeShellEnv.ts's two spawns and instances.ts's.
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`summary generation failed to spawn ${command}: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        return reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      let out: SummaryOutput;
      try { out = JSON.parse(stdout) as SummaryOutput; }
      catch (e) { return reject(new Error(`failed to parse claude output: ${stdout.slice(0, 200)}`)); }
      resolve(out);
    });

    // Guarded: on a failed spawn the streams are already destroyed, and an
    // unhandled EPIPE here would escape the same way 'error' used to.
    child.stdin.on('error', () => { /* surfaced via the 'error'/'close' paths above */ });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch { /* ditto */ }
  });

  const durationMs = Date.now() - startMs;
  const summary = parsed.result;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new Error(`unexpected claude output shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return {
    summary: summary.trim(),
    messageCount,
    durationMs,
    // The CLI's total_cost_usd is Anthropic list pricing — meaningless for a
    // substitution backend (src/costTracking.ts:130-132, docs/models.md).
    costUsd: fastBackend.backend === CLAUDE_BACKEND_ID
      ? ((parsed.total_cost_usd ?? parsed.cost_usd ?? null) as number | null)
      : null,
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
