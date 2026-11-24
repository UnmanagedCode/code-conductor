import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { pidAlive } from '../src/plugins/ports.ts';
import { hasMarker } from './procTree.mjs';
import { waitFor } from './plugin-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARENT = path.join(here, 'fixtures', 'plugin-supervisor-parent.mjs');

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// A backend whose original cc is gone writes to stdout/stderr without dying,
// and what it wrote is kept in the log file. The old cc is a real process that
// exits without stopping its child, so the pipes (if any) lose their reader.
test('an orphaned backend writes to stdout/stderr without dying, and the output is kept', async (t) => {
  // Teardown registered before any await. Only a pid proven to be this run's
  // (CC_TEST_RUN_ID in its environ) is signalled, as a group.
  const held = { pid: 0, parent: null };
  t.after(() => {
    if (held.parent && held.parent.exitCode === null) held.parent.kill('SIGKILL');
    if (held.pid && hasMarker(held.pid, process.env.CC_TEST_RUN_ID)) {
      try { process.kill(-held.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  const logDir = await mkdtemp('orphan-log-');
  const parent = spawn(process.execPath, [PARENT, logDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  held.parent = parent;
  let out = '';
  parent.stdout.on('data', (d) => { out += d; });
  await new Promise((res) => parent.once('exit', res));
  const { pid, port, log } = JSON.parse(out.trim().split('\n').pop());
  held.pid = pid;

  assert.equal(await get(port, '/say?n=50'), 200, 'the write into the orphaned stdio completed');
  assert.equal(await get(port, '/health'), 200, 'the backend is still serving');
  assert.ok(pidAlive(pid), 'the backend is still alive');

  const text = await waitFor(() => {
    const s = readFileSync(log, 'utf8');
    return s.includes('say-out-49') && s.includes('say-err-49') ? s : false;
  });
  assert.match(text, /fake-plugin listening on/, 'the first run\'s output was kept too');
});
