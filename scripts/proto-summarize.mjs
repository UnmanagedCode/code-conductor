#!/usr/bin/env node
// Throwaway prototype runner: generates short/medium/long summaries of a real
// session transcript so we can eyeball Haiku output quality.
//
// Usage:
//   node scripts/proto-summarize.mjs
//   node scripts/proto-summarize.mjs <sessionId> <cwd>

import { generateSummary, flattenTranscript } from '../src/summarize.js';

// Hardcoded to the largest code-conductor session found on disk:
//   3.1 MB, 752 user+assistant lines
//   worktree: /data/data/com.termux/files/home/cc-projects/code-conductor_worktree_0f1072
//   session:  8b5638ca-3fd6-4b5b-a12c-7b6095ec0ffc
const DEFAULT_SESSION_ID = '8b5638ca-3fd6-4b5b-a12c-7b6095ec0ffc';
const DEFAULT_CWD = '/data/data/com.termux/files/home/cc-projects/code-conductor_worktree_0f1072';

const [,, argSid, argCwd] = process.argv;
const sessionId = argSid || DEFAULT_SESSION_ID;
const cwd = argCwd || DEFAULT_CWD;

console.log('='.repeat(72));
console.log('Session:', sessionId);
console.log('CWD:    ', cwd);

// Report input stats
const { conversationText, messageCount } = await flattenTranscript(sessionId, cwd);
console.log(`Input:   ${messageCount} user+assistant lines, ${conversationText.length.toLocaleString()} chars (after cap)`);
console.log('='.repeat(72));
console.log();

for (const length of ['short', 'medium', 'long']) {
  console.log(`${'─'.repeat(72)}`);
  console.log(`SIZE: ${length.toUpperCase()}`);
  console.log('─'.repeat(72));

  const result = await generateSummary(sessionId, cwd, length);

  console.log(result.summary);
  console.log();
  console.log(`  messageCount: ${result.messageCount}  |  inputChars: ${conversationText.length.toLocaleString()}  |  durationMs: ${result.durationMs}  |  costUsd: ${result.costUsd}`);
  console.log();
}
