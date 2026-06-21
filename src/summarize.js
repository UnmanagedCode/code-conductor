// One-shot session summarization via `claude -p --output-format=json`.
// No in-process fetch — outbound DNS is broken on this host; the CLI
// handles all networking.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { claudeProjectsRoot, encodeCwd } from './projects.js';
import { resolveClaudeBin } from './instances.js';
import { DEFAULT_VERSIONS } from './modelVersions.js';

const LENGTH_INSTRUCTIONS = {
  short: '2-3 sentences',
  medium: '5-8 sentences',
  long: '3-4 paragraphs',
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

// Generate a summary of a session by running `claude -p` as a one-shot
// subprocess. Returns { summary, messageCount, durationMs, costUsd }.
export async function generateSummary(sessionId, cwd, length = 'medium') {
  const instruction = LENGTH_INSTRUCTIONS[length];
  if (!instruction) throw Object.assign(new Error(`invalid length: ${length}`), { statusCode: 400 });

  const { conversationText, messageCount } = await flattenTranscript(sessionId, cwd);

  const prompt = `Summarize the following Claude Code session conversation in ${instruction}.

Focus on: what the user wanted to accomplish, what was built or changed, key decisions made. Skip tool call details; describe outcomes and results.

CONVERSATION:
${conversationText}
---
Provide the summary only, no preamble:`;

  const { command, prefixArgs } = resolveClaudeBin();
  const args = [
    ...prefixArgs,
    '-p',
    '--output-format=json',
    '--model', DEFAULT_VERSIONS.haiku,
  ];

  const startMs = Date.now();

  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (e) { return reject(new Error(`failed to parse claude output: ${stdout.slice(0, 200)}`)); }
      resolve(parsed);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

  const durationMs = Date.now() - startMs;
  const summary = result.result;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new Error(`unexpected claude output shape: ${JSON.stringify(result).slice(0, 200)}`);
  }

  return {
    summary: summary.trim(),
    messageCount,
    durationMs,
    costUsd: result.total_cost_usd ?? result.cost_usd ?? null,
  };
}
