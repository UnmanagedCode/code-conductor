// The `npm test` gate (tests/gate.mjs): what it plans to run, that both suites
// always run and either one reds the gate, that an interrupt starts no further
// suite, and that the heap cap reaches node test children. The suites driven here
// are `node -e` fakes; no real suite runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { planSuites, runSuites, gateExit } from './gate.mjs';

const fake = (name, src) => ({ name, cmd: process.execPath, args: ['-e', src] });

test('npm test gate', async (t) => {
  await t.test('the default plan is the node suite then Vitest, and no Playwright', () => {
    const suites = planSuites([]);
    assert.deepEqual(suites.map((s) => s.name), ['node', 'web']);
    const [node, web] = suites;
    assert.equal(node.cmd, process.execPath);
    assert.deepEqual(node.args, ['tests/run.mjs']);
    assert.equal(web.cmd, process.execPath);
    assert.equal(path.basename(web.args[0]), 'vitest.mjs');
    assert.ok(fs.existsSync(web.args[0]), `vitest bin ${web.args[0]} must exist`);
    assert.deepEqual(web.args.slice(1), ['run', '--config', 'web/vitest.config.ts']);
    for (const s of suites) assert.ok(!s.args.some((a) => /playwright/i.test(a)), `${s.name} must not run Playwright`);
  });

  await t.test('file arguments go to the node suite alone', () => {
    const suites = planSuites(['tests/a.test.mjs', 'tests/b.test.mjs']);
    assert.deepEqual(suites.map((s) => s.name), ['node']);
    assert.deepEqual(suites[0].args, ['tests/run.mjs', 'tests/a.test.mjs', 'tests/b.test.mjs']);
  });

  await t.test('a red second suite after a green first one reds the gate and is named', async () => {
    const suites = [fake('node', ''), fake('web', 'process.exit(1)')];
    const { code, summary } = gateExit(suites, await runSuites(suites));
    assert.notEqual(code, 0);
    assert.match(summary, /node PASSED/);
    assert.match(summary, /web FAILED \(exit 1\)/);
  });

  await t.test('a red first suite still runs the second', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gate-'));
    try {
      const marker = path.join(dir, 'ran');
      const suites = [fake('node', 'process.exit(1)'), fake('web', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)];
      const results = await runSuites(suites);
      assert.ok(fs.existsSync(marker), 'the second suite must run after a red first one');
      const { code, summary } = gateExit(suites, results);
      assert.notEqual(code, 0);
      assert.match(summary, /node FAILED \(exit 1\)/);
      assert.match(summary, /web PASSED/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('all green exits 0', async () => {
    const suites = [fake('node', ''), fake('web', '')];
    assert.equal(gateExit(suites, await runSuites(suites)).code, 0);
  });

  await t.test('a suite ended by a signal starts no further suite and exits 128 + signo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gate-'));
    try {
      const marker = path.join(dir, 'ran');
      const suites = [fake('node', "process.kill(process.pid, 'SIGTERM')"),
        fake('web', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)];
      const results = await runSuites(suites);
      assert.ok(!fs.existsSync(marker), 'no suite may start after one is signalled');
      const { code, summary } = gateExit(suites, results);
      assert.equal(code, 143);
      assert.match(summary, /node FAILED \(SIGTERM\)/);
      assert.match(summary, /web NOT RUN/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The gate's signal state is module-level, so each case imports its own instance
  // (a distinct URL is a distinct ESM module) and a recorded signal cannot leak
  // into the cases above. onSignal is called right after runSuites spawns the first
  // suite, which is then certainly alive: it is a `node -e ''` that exits 0 on its
  // own unless something signals it.
  const interrupt = async (signal) => {
    const gate = await import(`./gate.mjs?${signal}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gate-'));
    try {
      const marker = path.join(dir, 'ran');
      const suites = [fake('node', ''), fake('web', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)];
      const running = gate.runSuites(suites);
      gate.onSignal(signal);
      const results = await running;
      return { results, laterSuiteRan: fs.existsSync(marker), ...gate.gateExit(suites, results) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  await t.test('SIGTERM to the gate kills the running suite and starts no later one', async () => {
    const { results, laterSuiteRan, code, summary } = await interrupt('SIGTERM');
    assert.deepEqual(results, [{ name: 'node', code: null, signal: 'SIGTERM' }]);
    assert.ok(!laterSuiteRan, 'no suite may start after the gate is signalled');
    assert.equal(code, 143);
    assert.match(summary, /web NOT RUN/);
  });

  await t.test('SIGINT to the gate leaves the running suite alone and starts no later one', async () => {
    const { results, laterSuiteRan, code, summary } = await interrupt('SIGINT');
    assert.deepEqual(results, [{ name: 'node', code: 0, signal: null }]);
    assert.ok(!laterSuiteRan, 'no suite may start after the gate is signalled');
    assert.equal(code, 130);
    assert.match(summary, /web NOT RUN/);
  });

  await t.test('tests/run.mjs caps the heap of its test children', () => {
    assert.match(process.env.NODE_OPTIONS ?? '', /--max-old-space-size=512/);
    assert.ok(v8.getHeapStatistics().heap_size_limit < 1024 ** 3, 'heap limit must be under 1 GiB');
  });
});
