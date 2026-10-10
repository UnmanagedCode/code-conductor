// The fake CLI, plus — only when it runs as a session worker (cc starts every
// worker with `--input-format=stream-json`, in its launch args in
// src/instances.ts; a one-shot probe such as `--version` never carries it) — a
// grandchild it leaves behind: detached (its own process group) and deaf to
// SIGTERM, so neither cc's shutdown nor its worker's death reaches it. Its pid
// is appended to $E2E_ORPHAN_PIDS. harness.spec.ts uses it to prove close()
// kills every descendant of the booted cc.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (process.argv.includes('--input-format=stream-json')) {
  const orphan = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    detached: true, stdio: 'ignore',
  });
  orphan.unref();
  fs.appendFileSync(process.env.E2E_ORPHAN_PIDS, `${orphan.pid}\n`);
}
await import('../../../tests/fake-claude.mjs');
