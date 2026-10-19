// Each test-running entry point takes its slot BEFORE it does any work: with every
// slot held, it prints the waiting line and its work stays undone until a slot is
// released. Slot mechanics are tests/test-slot.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { acquireTestSlot, HELD_VAR } from './testSlot.mjs';
import { mkdtempSync } from './tmpRegistry.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

async function freePair() {
  const listen = (port) => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ port, host: '127.0.0.1' }, () => resolve(s));
  });
  const close = (s) => new Promise((resolve) => s.close(() => resolve()));
  for (;;) {
    const probe = await listen(0);
    const port = probe.address().port;
    await close(probe);
    try { await close(await listen(port + 1)); return port; } catch { /* retry */ }
  }
}

// Hold both slots of a private pair, run `argv` under that pair, and hand the test
// the child, its output so far and a way to free the slots.
async function runBlocked(argv, { env: extra = {}, cwd = repo } = {}) {
  const base = await freePair();
  const env = { ...process.env, CC_TEST_SLOT_PORT: String(base), CC_TEST_SLOTS: '2', ...extra };
  delete env[HELD_VAR];
  // A nested node:test runner refuses to run inside a test file's context.
  delete env.NODE_TEST_CONTEXT;
  const held = [await acquireTestSlot({ label: 'blocker-1', env, log() {} }), await acquireTestSlot({ label: 'blocker-2', env, log() {} })];
  const child = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  const waiters = [];
  const pump = (name) => (d) => {
    out[name] += d;
    for (const w of [...waiters]) if (w.re.test(out.stdout + out.stderr)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  };
  child.stdout.on('data', pump('stdout'));
  child.stderr.on('data', pump('stderr'));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    out, exited,
    until: (re) => (re.test(out.stdout + out.stderr) ? Promise.resolve() : new Promise((resolve) => waiters.push({ re, resolve }))),
    free: () => Promise.all(held.map((l) => l.release())),
    kill: () => child.kill('SIGKILL'),
  };
}

const tmpDir = () => mkdtempSync('cc-slot-wiring-');

test('tests/run.mjs queues before running any file', async () => {
  const dir = tmpDir();
  const marker = path.join(dir, 'ran');
  const fixture = path.join(dir, 'marker.test.mjs');
  fs.writeFileSync(fixture, `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('x', () => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`);
  const run = await runBlocked(['tests/run.mjs', fixture]);
  try {
    await run.until(/test slot: waiting/);
    assert.equal(fs.existsSync(marker), false);
    await run.free();
    assert.equal(await run.exited, 0, run.out.stdout + run.out.stderr);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    run.kill();
  }
});

test('Vitest starts no worker before its slot is held, and the workers inherit the held marker', async () => {
  const dir = tmpDir();
  const marker = path.join(dir, 'worker-ran');
  const run = await runBlocked([vitestBin, 'run', '--config', 'web/vitest.config.ts', 'web/src/test/slotHeld.test.ts'],
    { env: { NO_COLOR: '1', SLOT_MARKER: marker } });
  try {
    await run.until(/test slot: waiting/);
    // Long enough that ungated workers would have started and run the test.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(fs.existsSync(marker), false);
    await run.free();
    // The worker's own assertion on the held marker is what turns this exit non-zero.
    assert.equal(await run.exited, 0, run.out.stdout + run.out.stderr);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    run.kill();
  }
});

test('the mutation wrapper queues before the runner starts, and hands it the held marker', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.plugins', 'code-mutant'), { recursive: true });
  fs.writeFileSync(path.join(root, '.plugins', 'code-mutant', 'mutate.mjs'), `console.log('RUNNER held=' + process.env.${HELD_VAR});\n`);
  const run = await runBlocked(['harness/mutation/run.mjs', 'baseline'], { env: { CC_PROJECTS_ROOT: root } });
  try {
    await run.until(/test slot: waiting/);
    assert.doesNotMatch(run.out.stdout, /RUNNER/);
    await run.free();
    assert.equal(await run.exited, 0, run.out.stdout + run.out.stderr);
    assert.match(run.out.stdout, /RUNNER held=\d+/);
  } finally {
    run.kill();
  }
});

test('the npm test gate queues before its first step, and its steps inherit the held marker', async () => {
  const dir = tmpDir();
  const npm = path.join(dir, 'npm-stub.mjs');
  fs.writeFileSync(npm, `console.log('STEP held=' + process.env.${HELD_VAR});\n`);
  const run = await runBlocked(['tests/gate.mjs', 'tests/narration-classify.test.mjs'], { env: { npm_execpath: npm } });
  try {
    await run.until(/test slot: waiting/);
    assert.doesNotMatch(run.out.stdout, /STEP/);
    await run.free();
    assert.equal(await run.exited, 0, run.out.stdout + run.out.stderr);
    assert.match(run.out.stdout, /STEP held=\d+/);
  } finally {
    run.kill();
  }
});
