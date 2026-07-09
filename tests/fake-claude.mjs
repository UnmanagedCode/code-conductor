#!/usr/bin/env node
// Thin subprocess entrypoint for the fake `claude` CLI. All protocol logic lives
// in ./fake-claude-engine.mjs (shared with the in-process launcher — single
// source of truth). This wrapper just maps the OS process's argv/env/cwd/stdio
// onto runFakeClaude and mirrors the old SIGTERM → close-reader behavior.
//
// Used only by tests that genuinely need a real OS process (bootServer
// `realProcess:true`) and the RUN_REAL_CLAUDE smoke suite. The default test path
// runs the engine in-process (no subprocess) — see tests/inProcessLauncher.mjs.

import { runFakeClaude } from './fake-claude-engine.mjs';

const code = await runFakeClaude({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  onReaderReady: (closeReader) => process.on('SIGTERM', closeReader),
});
process.exit(code);
