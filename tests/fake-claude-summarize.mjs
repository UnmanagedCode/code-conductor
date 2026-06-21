#!/usr/bin/env node
// Minimal fake for `claude -p --output-format=json` in summary tests.
// Drains stdin (the prompt), emits a canned result JSON, exits 0.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
for await (const _ of rl) { /* drain */ }

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'This is a canned test summary of the session.',
  session_id: 'fake-session-id',
  cost_usd: 0.0001,
}) + '\n');
process.exit(0);
