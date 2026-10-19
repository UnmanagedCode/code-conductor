// One-shot session summarization, titling and free-form questions. The prompt
// shape (session text in the system prompt, task last) and the subprocess live
// in sessionOneShot.ts; this module owns the transcript flattening and the
// task wording.

import { promises as fs } from 'node:fs';
import { sessionFilePath, findSessionLocation, type TranscriptPlacement } from './projects.ts';
import { runSessionOneShot, type OneShotUsage } from './sessionOneShot.ts';
import { SUMMARY_LENGTHS, type SummaryLength } from './sessionSummaries.ts';
import { httpError } from './httpError.ts';

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

// A persisted session line narrowed to the fields flattenTranscript/countMessages read.
interface TranscriptLine {
  type?: unknown;
  message?: { content?: unknown } | null;
}

// Read the session jsonl and return { conversationText, messageCount }.
// messageCount = number of type:'user' + type:'assistant' lines.
// conversationText is formatted as "User: ...\nAssistant: ...\n\n" turns,
// capped at INPUT_CAP chars.
export async function flattenTranscript(sessionId: string, place: TranscriptPlacement): Promise<{ conversationText: string; messageCount: number }> {
  const file = sessionFilePath(place, sessionId);
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
export async function countMessages(sessionId: string, place: TranscriptPlacement): Promise<number> {
  const file = sessionFilePath(place, sessionId);
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

// The task for a tier summary: the user message, sent after the cached
// session-text system prompt.
function summaryTask(tier: { depth: string; budget: string; structure: string }): string {
  return `Summarize the Claude Code session in the conversation.

Coverage: ${tier.depth}
Word budget: ${tier.budget} of CONTENT words.

Focus on: what the user wanted to accomplish, what was built or changed, key decisions made. Skip tool call details; describe outcomes and results.

${tier.structure}

Critical word-count rule: the word budget counts CONTENT words only — the actual words of information you write. Markdown scaffolding (#, ##, |, -, *, ** markers, table pipes and dashes) does NOT count toward the budget. Judge your length by the informational words, not the formatting. A compact table with 30 content words is not "over budget" because of its pipes. This means: use markdown structure freely to improve scannability; only the substance counts.

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
function titleTask(projectHint: string | null): string {
  return `Name the CURRENT end goal of the Claude Code session in the conversation.

This is not a recap. Work that is already finished matters only as context: say what the session is trying to achieve RIGHT NOW — the objective the most recent turns are working toward. If the goal changed mid-session, the latest one wins. If the latest turns are verifying or fixing up earlier work, that clean-up IS the current goal.

First, determine which PROJECT this session concerns, from the conversation itself: the projects it spawns workers into, the paths and repos it operates on or discusses. If it touches several, name the one the CURRENT goal concerns. This may be an orchestrator/conductor session whose own working directory is not a project at all — never output "conduct" or ".conduct" as the project name; a conductor session is always actually about some OTHER project named somewhere in the conversation.${projectHint ? ` Hint only, derived from the session's checkout path, to use if the conversation itself is ambiguous — it does NOT override what the conversation says: "${projectHint}".` : ''}

If you identified a project: output exactly one line in the form "<Project>: <title>" — the project name, a colon, a space, then the title. The WHOLE line, project name included, must be at most 100 characters — this is a hard limit. Aim for the <title> part alone (not counting the "<Project>: " prefix) to be around 60 characters, but if the project name is long enough that "<Project>: " plus a 60-character title would exceed 100 characters total, shorten the <title> part to fit — never shorten, abbreviate, or drop the project name to make room.
If you could not identify any project: output just the title on its own, at most 60 characters total — no prefix, no colon, no invented project name.

Either way, the title itself: plain text only, no markdown, no surrounding quotes, no trailing period, no "Session:" or "Title:" prefix, no explanation before or after. Sentence case. Prefer a concrete noun phrase naming the thing being built, fixed, or investigated, never a vague category ("Code improvements").

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

// A free-form question about the session. Nothing follows the question, so
// the user message's tail is exactly what the asker typed.
function questionTask(question: string): string {
  return `Answer the question below about the Claude Code session in the conversation. Answer from the conversation only; if it does not contain the answer, say so. Markdown is fine.

QUESTION:
${question.trim()}`;
}

// The session text lives in the SYSTEM prompt and the task in the user message,
// so every task over unchanged session text shares one byte-stable cache
// prefix. The prefix holds no dynamic value (date, cwd, project hint, ids).
export function buildSessionPrompt(conversationText: string, task: string): { system: string; user: string } {
  return {
    system: `The text turns of a Claude Code session follow, in order; tool calls are omitted. The request is in the user message.

<conversation>
${conversationText}
</conversation>`,
    user: task,
  };
}

// Generate a summary (or title) of a session by running `claude -p` as a
// one-shot subprocess. Returns { summary, messageCount, durationMs, costUsd }.
export async function generateSummary(sessionId: string, place: TranscriptPlacement, length: SummaryLength = 'medium'): Promise<{ summary: string; messageCount: number; durationMs: number; costUsd: number | null }> {
  if (!(SUMMARY_LENGTHS as readonly string[]).includes(length)) {
    throw httpError(400, `invalid length: ${length}`);
  }

  const { conversationText, messageCount } = await flattenTranscript(sessionId, place);
  const task = length === 'title'
    ? titleTask(await projectNameHint(sessionId))
    : summaryTask(LENGTH_INSTRUCTIONS[length]);
  const { system, user } = buildSessionPrompt(conversationText, task);
  const { result, durationMs, costUsd } = await runSessionOneShot({ systemPrompt: system, prompt: user });
  return { summary: result, messageCount, durationMs, costUsd };
}

// Answer one free-form question about a session. Stores nothing.
export async function askSession(sessionId: string, place: TranscriptPlacement, question: unknown, signal?: AbortSignal): Promise<{ answer: string; costUsd: number | null; usage: OneShotUsage }> {
  if (typeof question !== 'string' || !question.trim()) {
    throw httpError(400, 'question must be a non-empty string');
  }
  const { conversationText } = await flattenTranscript(sessionId, place);
  const { system, user } = buildSessionPrompt(conversationText, questionTask(question));
  const { result, costUsd, usage } = await runSessionOneShot({ systemPrompt: system, prompt: user, signal });
  return { answer: result, costUsd, usage };
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
