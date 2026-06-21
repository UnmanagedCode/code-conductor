#!/usr/bin/env node
// Throwaway prototype runner: generates short/medium/long summaries of a real
// session transcript so we can eyeball Haiku output quality.
//
// Usage:
//   node scripts/proto-summarize.mjs
//   node scripts/proto-summarize.mjs <sessionId> <cwd>

import { generateSummary, flattenTranscript } from '../src/summarize.js';

const SESSIONS = [
  {
    label: 'LARGE SESSION (752 turns, 3.1 MB)',
    sessionId: '8b5638ca-3fd6-4b5b-a12c-7b6095ec0ffc',
    cwd: '/data/data/com.termux/files/home/cc-projects/code-conductor_worktree_0f1072',
    jsonl: '~/.claude/projects/-data-data-com-termux-files-home-cc-projects-code-conductor-worktree-0f1072/8b5638ca-3fd6-4b5b-a12c-7b6095ec0ffc.jsonl',
  },
  {
    label: 'TYPICAL SESSION (58 turns, 843 KB)',
    sessionId: '4b408e53-b19f-4c35-895a-b933d06d59b5',
    cwd: '/data/data/com.termux/files/home/cc-projects/code-conductor_worktree_a3c415',
    jsonl: '~/.claude/projects/-data-data-com-termux-files-home-cc-projects-code-conductor-worktree-a3c415/4b408e53-b19f-4c35-895a-b933d06d59b5.jsonl',
  },
];

async function runSession({ label, sessionId, cwd, jsonl }) {
  console.log('='.repeat(72));
  console.log(`RUN: ${label}`);
  console.log(`File:    ${jsonl}`);
  console.log(`Session: ${sessionId}`);
  console.log(`CWD:     ${cwd}`);

  const { conversationText, messageCount } = await flattenTranscript(sessionId, cwd);
  console.log(`Input:   ${messageCount} user+assistant lines, ${conversationText.length.toLocaleString()} chars (after cap)`);
  console.log('='.repeat(72));
  console.log();

  for (const length of ['short', 'medium', 'long']) {
    console.log('─'.repeat(72));
    console.log(`SIZE: ${length.toUpperCase()}`);
    console.log('─'.repeat(72));

    const result = await generateSummary(sessionId, cwd, length);

    console.log(result.summary);
    console.log();
    console.log(`  messageCount: ${result.messageCount}  |  inputChars: ${conversationText.length.toLocaleString()}  |  durationMs: ${result.durationMs}  |  costUsd: ${result.costUsd}`);
    console.log();
  }
}

for (const session of SESSIONS) {
  await runSession(session);
  console.log();
}
