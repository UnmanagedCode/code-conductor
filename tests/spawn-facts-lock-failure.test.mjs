// The failure path of launch()'s wait on the spawn-time store facts: a write that
// cannot land (the store lock held by a live PID past the retry budget) is logged
// by the store and must neither reject nor hang create().
//
// A file of its own: storeLock.ts reads the retry budget at module load, so this
// small budget would starve the default-budget forcing in backend-spawn.test.mjs,
// whose lock has to outlive spawn→idle.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ORCH_STORE_LOCK_RETRY_MAX = '2';
process.env.ORCH_STORE_LOCK_RETRY_BASE_MS = '5';

const { bootServer, api, waitFor, waitForIdleOrExit, freshProjectsRoot, rmrf } = await import('./helpers.mjs');
const { sessionsFile, isTemp } = await import('../src/sessionStore.ts');
const { claudeProjectsRoot, encodeCwd } = await import('../src/projects.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

test('a spawn-time write that fails on a held store lock is logged and never rejects or hangs create()', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sid = 'cdcdcdcd-0000-0000-0000-000000000000';
  const dir = path.join(claudeProjectsRoot(), encodeCwd(path.join(projectsRoot, 'p')));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
  const lockPath = sessionsFile() + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held-by-test' }));

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  let deadline;
  try {
    const timeout = new Promise((_, rej) => {
      deadline = setTimeout(() => rej(new Error('launch() hung on a held store lock')), 5000);
    });
    const inst = await Promise.race([
      instances.create({ project: 'p', resume: sid, temp: true, mode: 'plan' }),
      timeout,
    ]);
    await waitForIdleOrExit(inst);
    for (const op of ['setSegmentTemp', 'setSessionMode']) {
      assert.ok(warns.some(w => w.includes(`sessionStore: ${op} ${sid} failed:`) && w.includes('could not acquire')),
        `the store logged the failed ${op}:\n${warns.join('\n')}`);
    }
    // Reads take no lock: temp absent proves the write really failed.
    assert.equal(await isTemp(sid), false, 'forcing engaged: the temp write did not land');
  } finally {
    clearTimeout(deadline);
    console.warn = origWarn;
    await fs.unlink(lockPath).catch(() => {});
  }
});
