// Regression test for audit finding F1: sessionTitles and sessionSummaries were
// the two sidecar stores that never took the cross-process advisory lock.
//
// The other four (conducted / temp / backends / archived) were hardened against
// a lost update after archived sessions silently un-archived themselves around
// restarts — the old server exiting and the new one booting are the one window
// with genuine cross-process contention on `<store>/*.json`. Titles and
// summaries do the same load -> mutate -> write-whole-document dance, so they
// had the same bug; nobody had noticed because losing a custom title is quieter
// than losing an archive flag.
//
// The race is made DETERMINISTIC rather than probabilistic, using the same
// holder/waiter shape as tests/archived-lock-lost-update.test.mjs:
//
//   1. HOLDER plants a lockfile naming its own live pid (a live owner is never
//      evicted), reads the store, signals ready, sleeps, then commits its own
//      document.
//   2. WAITER waits for the ready signal, then calls the REAL setTitle /
//      setSummary once, in its own process, against the same store root.
//
// WITH the lock: the waiter blocks until the holder releases, re-reads the
// holder's committed document, and adds to it — everything survives.
// WITHOUT it (HEAD before this fix): the waiter reads the pre-holder snapshot
// and writes immediately, and the holder's later write clobbers the waiter's
// entry. The holder's sleep guarantees that ordering, so the failure is not a
// coin flip.

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

async function runRace({ storeFileName, moduleFile, waiterCall, holderDoc }) {
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

// FAILS on HEAD before F1 (sessionTitles took no lock → the holder's later write
// clobbers the waiter's title); PASSES once setTitle mutates under withLock.
test('a concurrent title write is not lost to another process', { timeout: 30000 }, async () => {
  const doc = await runRace({
    storeFileName: 'session-titles.json',
    moduleFile: 'sessionTitles.ts',
    waiterCall: `await m.setTitle('waiter-sid', 'waiter title');`,
    holderDoc: { titles: { 'holder-sid-1': 'holder one', 'holder-sid-2': 'holder two' } },
  });
  assert.equal(doc.titles['holder-sid-1'], 'holder one', "the holder's title was lost");
  assert.equal(doc.titles['holder-sid-2'], 'holder two', "the holder's title was lost");
  assert.equal(doc.titles['waiter-sid'], 'waiter title',
    "the waiter's title was lost — setTitle read a snapshot the holder then clobbered");
});

// Same shape for the summaries store, which had the identical gap.
test('a concurrent summary write is not lost to another process', { timeout: 30000 }, async () => {
  const doc = await runRace({
    storeFileName: 'session-summaries.json',
    moduleFile: 'sessionSummaries.ts',
    waiterCall: `await m.setSummary('waiter-sid', 'short', { summary: 'waiter summary', generatedAt: 1, messageCount: 2 });`,
    holderDoc: {
      summaries: { 'holder-sid': { short: { summary: 'holder summary', generatedAt: 1, messageCount: 1 } } },
    },
  });
  assert.equal(doc.summaries['holder-sid']?.short?.summary, 'holder summary',
    "the holder's summary was lost");
  assert.equal(doc.summaries['waiter-sid']?.short?.summary, 'waiter summary',
    "the waiter's summary was lost — setSummary read a snapshot the holder then clobbered");
});

// In-process companion to the cross-process races above. Every store does a
// load -> mutate -> write-the-whole-document, so N concurrent mutations from one
// process must all survive: whichever ordering the chain picks, no write may be
// based on a snapshot another write has already superseded.
//
// Scoped honestly: this pins CORRECTNESS, which `withLock` alone also provides
// (it is O_EXCL, so it excludes same-process callers too). It does NOT pin the
// `serialize` chain — that is a contention guard keeping same-process writers
// off the lockfile, and removing it is deliberately not observable here.
test('concurrent same-process title writes all survive', async () => {
  const dir = await fs.mkdtemp(path.join(tmp, 'inproc-'));
  process.env.PROJECTS_ROOT = dir;
  const titles = await import('file://' + path.join(srcDir, 'sessionTitles.ts'));

  const ids = Array.from({ length: 25 }, (_, i) => `sid-${String(i).padStart(2, '0')}`);
  await Promise.all(ids.map(id => titles.setTitle(id, `title ${id}`)));

  const got = await titles.loadAll();
  assert.equal(got.size, ids.length, `expected all ${ids.length} titles, got ${got.size}`);
  for (const id of ids) assert.equal(got.get(id), `title ${id}`, `title for '${id}' was lost`);
});
