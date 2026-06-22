#!/usr/bin/env node
// Minimal fake for `claude -p --output-format=json` in summary tests.
// Drains stdin (the prompt), emits a canned result JSON, exits 0.
//
// Test seams:
//   FAKE_SUMMARIZE_CWD_OUT  — path to write process.cwd() to (for cwd assertion)
//   FAKE_SUMMARIZE_WRITE_JSONL=1 — simulate the real CLI by creating a dummy
//     artifact jsonl at <CLAUDE_PROJECTS_ROOT>/<encodedCwd>/<sessionId>.jsonl
//     (so the cleanup test can verify it gets deleted).
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);

// Parse --session-id <id> from args.
const sidIdx = args.indexOf('--session-id');
const sessionId = sidIdx !== -1 ? args[sidIdx + 1] : null;

// Drain stdin.
const rl = createInterface({ input: process.stdin });
for await (const _ of rl) { /* drain */ }

// Write cwd to the designated file (for test assertion).
if (process.env.FAKE_SUMMARIZE_CWD_OUT) {
  await fs.writeFile(process.env.FAKE_SUMMARIZE_CWD_OUT, process.cwd()).catch(() => {});
}

// Simulate the real CLI artifact jsonl so cleanup can be tested.
if (process.env.FAKE_SUMMARIZE_WRITE_JSONL === '1' && sessionId) {
  const claudeRoot = process.env.CLAUDE_PROJECTS_ROOT
    ?? path.join(os.homedir(), '.claude', 'projects');
  const encodedCwd = process.cwd().replace(/[^A-Za-z0-9-]/g, '-');
  const dir = path.join(claudeRoot, encodedCwd);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), '{"type":"fake"}\n').catch(() => {});
}

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'This is a canned test summary of the session.',
  session_id: sessionId ?? 'fake-session-id',
  cost_usd: 0.0001,
}) + '\n');
process.exit(0);
