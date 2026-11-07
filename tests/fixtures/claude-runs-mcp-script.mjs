// The fake CLI, plus — only when it runs as a session worker (every worker is
// launched with `--input-format=stream-json`) — a script it runs with its own
// inherited env, as a worker's Bash would: tests/fixtures/mcp-script-client.mjs.
// Used by tests/mcp-worker-script-e2e.test.mjs.
import { spawn } from 'node:child_process';
import path from 'node:path';

if (process.argv.includes('--input-format=stream-json')) {
  spawn(process.execPath, [path.join(import.meta.dirname, 'mcp-script-client.mjs')], {
    env: process.env, stdio: 'ignore',
  });
}
await import('../fake-claude.mjs');
