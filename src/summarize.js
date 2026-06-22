// One-shot session summarization via `claude -p --output-format=json`.
// No in-process fetch — outbound DNS is broken on this host; the CLI
// handles all networking.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeProjectsRoot, encodeCwd, orchStoreRoot } from './projects.js'; // claudeProjectsRoot+encodeCwd used by countMessages/flattenTranscript
import { resolveClaudeBin } from './instances.js';
import { DEFAULT_VERSIONS } from './modelVersions.js';

// Dedicated cwd for one-shot summary subprocesses: a subdirectory inside
// the .code-conductor metadata dir. It is NOT under PROJECTS_ROOT as a
// named project, so the CLI's session jsonl for the one-shot call lands
// in an isolated encoded dir that never appears in the conductor sidebar.
// We do NOT delete those jsonls — they are harmless litter in an opaque
// metadata dir, and reaching into ~/.claude/projects/ to delete them is
// fragile. Exported so tests can introspect the expected spawn cwd.
export function summarySpawnDir() {
  return path.join(orchStoreRoot(), 'summaries');
}

const LENGTH_INSTRUCTIONS = {
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

// Read the session jsonl and return { conversationText, messageCount }.
// messageCount = number of type:'user' + type:'assistant' lines.
// conversationText is formatted as "User: ...\nAssistant: ...\n\n" turns,
// capped at INPUT_CAP chars.
export async function flattenTranscript(sessionId, cwd) {
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error(`session not found: ${sessionId}`), { code: 'ENOENT' });
    throw e;
  }

  const turns = [];
  let messageCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) continue;

    messageCount++;
    const content = obj.message?.content;
    if (!content) continue;

    // Extract only text blocks; skip tool_use / tool_result entirely.
    const texts = [];
    if (typeof content === 'string') {
      if (content.trim()) texts.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const block of content) {
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
export async function countMessages(sessionId, cwd) {
  const file = path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj && (obj.type === 'user' || obj.type === 'assistant')) count++;
  }
  return count;
}

// Generate a summary of a session by running `claude -p` as a one-shot
// subprocess. Returns { summary, messageCount, durationMs, costUsd }.
export async function generateSummary(sessionId, cwd, length = 'medium') {
  const tier = LENGTH_INSTRUCTIONS[length];
  if (!tier) throw Object.assign(new Error(`invalid length: ${length}`), { statusCode: 400 });

  const { conversationText, messageCount } = await flattenTranscript(sessionId, cwd);

  const prompt = `Summarize the following Claude Code session.

Coverage: ${tier.depth}
Word budget: ${tier.budget} of CONTENT words.

Focus on: what the user wanted to accomplish, what was built or changed, key decisions made. Skip tool call details; describe outcomes and results.

${tier.structure}

Critical word-count rule: the word budget counts CONTENT words only — the actual words of information you write. Markdown scaffolding (#, ##, |, -, *, ** markers, table pipes and dashes) does NOT count toward the budget. Judge your length by the informational words, not the formatting. A compact table with 30 content words is not "over budget" because of its pipes. This means: use markdown structure freely to improve scannability; only the substance counts.

CONVERSATION:
${conversationText}
---
Provide the summary only, no preamble:`;

  const { command, prefixArgs } = resolveClaudeBin();
  // Throwaway session-id so each generation is independent (no accidental
  // resume of a prior one-shot call).
  const scratchId = randomUUID();
  const args = [
    ...prefixArgs,
    '-p',
    '--output-format=json',
    '--model', DEFAULT_VERSIONS.haiku,
    '--session-id', scratchId,
  ];

  // Use a subdir inside the .code-conductor metadata dir as the spawn cwd.
  // That path is not listed as a project under PROJECTS_ROOT, so the CLI's
  // session jsonl never surfaces in the conductor sidebar.
  const spawnDir = summarySpawnDir();
  await fs.mkdir(spawnDir, { recursive: true });

  const startMs = Date.now();

  const parsed = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: spawnDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('summary generation timed out after 60s'));
    }, 60_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        return reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      let out;
      try { out = JSON.parse(stdout); }
      catch (e) { return reject(new Error(`failed to parse claude output: ${stdout.slice(0, 200)}`)); }
      resolve(out);
    });

    child.stdin.write(prompt);
    child.stdin.end();
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
    costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? null,
  };
}
