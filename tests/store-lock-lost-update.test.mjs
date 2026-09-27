// The session store's writes under cross-process contention. The contended
// window is a hot restart: the exiting old server and the booting new one both
// load -> mutate -> write the whole `<store>/sessions.json`, so without the
// advisory lock one process's update is lost to the other's.
//
// The race is DETERMINISTIC rather than probabilistic, using the same
// holder/waiter shape as tests/archived-lock-lost-update.test.mjs:
//
//   1. HOLDER plants a lockfile naming its own live pid (a live owner is never
//      evicted), reads the store, signals ready, sleeps, then commits its own
//      document.
//   2. WAITER waits for the ready signal, then calls the REAL store writer once,
//      in its own process, against the same store root.
//
// With the lock, the waiter blocks until the holder releases, re-reads the
// holder's committed document, and adds to it — everything survives. Without
// it, the waiter reads the pre-holder snapshot and writes immediately, and the
// holder's later write clobbers the waiter's update. The holder's sleep
// guarantees that ordering, so the failure is not a coin flip.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-store-lu-'));
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const HOLD_MS = 1_200;

function waitExit(proc, label) {
  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${label} exit ${code}`)));
    proc.on('error', reject);
  });
}

// HOLDER: plants a lock carrying this live process's pid (a live owner is never
// evicted), snapshots, stalls, then commits snapshot + its own ids.
function holderSource() {
  return [
    `import { promises as fs } from 'node:fs';`,
    `const [dataFile, readyFile, holdMs, docJson] = process.argv.slice(2);`,
    `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`,
    `import path from 'node:path';`,
    `await fs.mkdir(path.dirname(dataFile), { recursive: true });`,
    `await fs.writeFile(dataFile + '.lock', JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'holder' }));`,
    `await fs.readFile(dataFile, 'utf8').catch(() => '{}');`, // snapshot read while "holding"
    `await fs.writeFile(readyFile, '1');`,
    `await sleep(Number(holdMs));`,
    `const t = dataFile + '.tmp-holder';`,
    `await fs.writeFile(t, docJson);`,
    `await fs.rename(t, dataFile);`,
    `await fs.unlink(dataFile + '.lock').catch(() => {});`,
  ].join('\n');
}

// WAITER: the real store API, in its own process, against the same store root.
function waiterSource(moduleFile, call) {
  return [
    `import { promises as fs } from 'node:fs';`,
    `const [readyFile] = process.argv.slice(2);`,
    `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`,
    `for (let i = 0; i < 400; i++) { try { await fs.access(readyFile); break; } catch { await sleep(5); } }`,
    `const m = await import(${JSON.stringify('file://' + path.join(srcDir, moduleFile))});`,
    call,
  ].join('\n');
}

async function runRace({ waiterCall, holderDoc }) {
  const storeFileName = 'sessions.json';
  const moduleFile = 'sessionStore.ts';
  const dir = await fs.mkdtemp(path.join(tmp, 'race-'));
  const storeRoot = path.join(dir, '.code-conductor');
  await fs.mkdir(storeRoot, { recursive: true });
  const dataFile = path.join(storeRoot, storeFileName);
  const readyFile = path.join(dir, 'ready');

  const holderPath = path.join(dir, 'holder.mjs');
  const waiterPath = path.join(dir, 'waiter.mjs');
  await fs.writeFile(holderPath, holderSource());
  await fs.writeFile(waiterPath, waiterSource(moduleFile, waiterCall));

  const holder = spawn(process.execPath,
    [holderPath, dataFile, readyFile, String(HOLD_MS), JSON.stringify(holderDoc, null, 2) + '\n'],
    { stdio: 'inherit' });
  const waiter = spawn(process.execPath, [waiterPath, readyFile],
    { stdio: 'inherit', env: { ...process.env, PROJECTS_ROOT: dir } });

  await Promise.all([waitExit(holder, 'holder'), waitExit(waiter, 'waiter')]);
  return JSON.parse(await fs.readFile(dataFile, 'utf8'));
}

const record = (id, extra = {}) => ({ current: id, segments: [{ id, reason: 'initial', at: '' }], ...extra });
const H1 = 'hhhhhhhh-0000-4000-8000-000000000001';
const H2 = 'hhhhhhhh-0000-4000-8000-000000000002';
const W = 'wwwwwwww-0000-4000-8000-000000000003';

test('a concurrent write to another session is not lost to another process', { timeout: 30000 }, async () => {
  const { sessions } = await runRace({
    waiterCall: `await m.setTitle(${JSON.stringify(W)}, 'waiter title');`,
    holderDoc: { sessions: {
      [H1]: record(H1, { title: 'holder one' }),
      [H2]: { current: H2, segments: [{ id: H2, reason: 'initial', at: '', archived: true }] },
    } },
  });
  assert.equal(sessions[H1]?.title, 'holder one', "the holder's title was lost");
  assert.equal(sessions[H2]?.segments[0].archived, true, "the holder's archived flag was lost");
  assert.equal(sessions[W]?.title, 'waiter title',
    "the waiter's title was lost — it read a snapshot the holder then clobbered");
});

test('a concurrent write to another field of the same session is not lost to another process', { timeout: 30000 }, async () => {
  const { sessions } = await runRace({
    waiterCall: `await m.setSummary(${JSON.stringify(H1)}, 'short', { summary: 'waiter summary', generatedAt: 1, messageCount: 2 });`,
    holderDoc: { sessions: { [H1]: record(H1, { title: 'holder title' }) } },
  });
  assert.equal(sessions[H1]?.title, 'holder title', "the holder's title was lost");
  assert.equal(sessions[H1]?.summaries?.short?.summary, 'waiter summary',
    "the waiter's summary was lost — it read a snapshot the holder then clobbered");
});

// In-process companion to the cross-process races above: N concurrent
// mutations from one process must all survive, whichever ordering the chain
// picks — no write may be based on a snapshot another write has superseded.
//
// Scoped honestly: this pins CORRECTNESS, which `withLock` alone also provides
// (it is O_EXCL, so it excludes same-process callers too). It does NOT pin the
// `serialize` chain — that is a contention guard keeping same-process writers
// off the lockfile, and removing it is deliberately not observable here.
test('concurrent same-process title writes all survive', async () => {
  const dir = await fs.mkdtemp(path.join(tmp, 'inproc-'));
  process.env.PROJECTS_ROOT = dir;
  const store = await import('file://' + path.join(srcDir, 'sessionStore.ts'));

  const ids = Array.from({ length: 25 }, (_, i) => `sid-${String(i).padStart(2, '0')}`);
  await Promise.all(ids.map(id => store.setTitle(id, `title ${id}`)));

  for (const id of ids) assert.equal(await store.getTitle(id), `title ${id}`, `title for '${id}' was lost`);
});
