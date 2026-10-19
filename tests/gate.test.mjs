// The `npm test` gate (tests/gate.mjs): how it routes its arguments, what it plans
// to run, that a red typecheck step stops the gate while both suites
// always run and either one reds the gate, that an interrupt starts no further
// suite, and that the heap cap reaches node test children. The suites driven here
// are `node -e` fakes; no real suite runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { changedGateScope, gateExit, parseGateArgs, planGate, runSuites, scopeOf, UsageError } from './gate.mjs';
import { mkdtempSync } from './tmpRegistry.mjs';

const fake = (name, src) => ({ name, cmd: process.execPath, args: ['-e', src] });
const REPO = path.resolve(import.meta.dirname, '..');
const NPM = '/fake/npm-cli.js';
const ENV = { npm_execpath: NPM };

test('npm test gate', async (t) => {
  await t.test('no arguments plan both typecheck halves, the node suite, then Vitest, and no Playwright', () => {
    assert.deepEqual(parseGateArgs([]), { mode: 'all' });
    const steps = planGate(scopeOf({ mode: 'all' }), ENV);
    assert.deepEqual(steps.map((s) => s.name), ['typecheck:node', 'typecheck:web', 'node', 'web']);
    const [tcNode, tcWeb, node, web] = steps;
    for (const [step, half] of [[tcNode, 'node'], [tcWeb, 'web']]) {
      assert.equal(step.cmd, process.execPath);
      assert.deepEqual(step.args, [NPM, 'run', `typecheck:${half}`]);
      assert.equal(step.blocking, true);
    }
    assert.equal(node.cmd, process.execPath);
    assert.deepEqual(node.args, ['tests/run.mjs']);
    assert.ok(!node.blocking && !web.blocking, 'a red suite must not skip the other');
    assert.equal(web.cmd, process.execPath);
    assert.equal(path.basename(web.args[0]), 'vitest.mjs');
    assert.ok(fs.existsSync(web.args[0]), `vitest bin ${web.args[0]} must exist`);
    assert.deepEqual(web.args.slice(1), ['run', '--config', 'web/vitest.config.ts']);
    for (const s of steps) assert.ok(!s.args.some((a) => /playwright/i.test(a)), `${s.name} must not run Playwright`);
  });

  await t.test('file arguments route tests/ to node and web/src/ to Vitest', () => {
    assert.deepEqual(parseGateArgs(['tests/a.test.mjs', 'web/src/b.test.ts', 'tests/c.test.mjs']),
      { mode: 'files', node: ['tests/a.test.mjs', 'tests/c.test.mjs'], web: ['web/src/b.test.ts'] });
    assert.deepEqual(parseGateArgs([path.join(REPO, 'web', 'src', 'b.test.ts'), './tests/a.test.mjs']),
      { mode: 'files', node: ['tests/a.test.mjs'], web: ['web/src/b.test.ts'] });
  });

  await t.test('a node-only file plan typechecks the node half and runs only those node files', () => {
    const steps = planGate(scopeOf(parseGateArgs(['tests/a.test.mjs', 'tests/b.test.mjs'])), ENV);
    assert.deepEqual(steps.map((s) => s.name), ['typecheck:node', 'node']);
    assert.deepEqual(steps[1].args, ['tests/run.mjs', 'tests/a.test.mjs', 'tests/b.test.mjs']);
  });

  await t.test('a web-only file plan typechecks the web half and hands the file to Vitest', () => {
    const steps = planGate(scopeOf(parseGateArgs(['web/src/b.test.ts'])), ENV);
    assert.deepEqual(steps.map((s) => s.name), ['typecheck:web', 'web']);
    assert.deepEqual(steps[1].args.slice(1), ['run', '--config', 'web/vitest.config.ts', 'web/src/b.test.ts']);
  });

  await t.test('a mixed file plan runs both halves and both suites on their own files', () => {
    const steps = planGate(scopeOf(parseGateArgs(['web/src/b.test.ts', 'tests/a.test.mjs'])), ENV);
    assert.deepEqual(steps.map((s) => s.name), ['typecheck:node', 'typecheck:web', 'node', 'web']);
    assert.deepEqual(steps[2].args, ['tests/run.mjs', 'tests/a.test.mjs']);
    assert.deepEqual(steps[3].args.slice(-1), ['web/src/b.test.ts']);
  });

  await t.test('arguments the gate cannot route are refused with a pointer', () => {
    const refused = (argv, pointer) => assert.throws(() => parseGateArgs(argv), (e) => e instanceof UsageError && pointer.test(e.message), argv.join(' '));
    refused(['web/e2e/x.spec.ts'], /npm run test:e2e/);
    refused(['web/playwright.config.ts'], /npm run test:e2e/);
    refused(['src/x.ts'], /tests\/ or web\/src\/.*--changed/);
    refused(['tests/a.test.mjs', '-t'], /npm run test:web -- -t .*npm run test:node takes test files only/);
    assert.throws(() => parseGateArgs(['-t']), (e) => !/test:node -- /.test(e.message), 'tests/run.mjs takes no flags');
    refused(['--changed', 'tests/a.test.mjs'], /--changed/);
    assert.deepEqual(parseGateArgs(['--changed']), { mode: 'changed' });
  });

  await t.test('the plan needs npm_execpath', () => {
    assert.throws(() => planGate(scopeOf({ mode: 'all' }), {}), (e) => e instanceof UsageError && /npm test/.test(e.message));
  });

  await t.test('--changed with no changes or a git failure runs the full gate', () => {
    const noReach = () => assert.fail('no reach is built without a diff');
    const failed = changedGateScope({ ok: false, reason: 'no main branch' }, noReach);
    const empty = changedGateScope({ ok: true, base: 'main', mergeBase: 'abc123', paths: [] }, noReach);
    for (const { scope, lines } of [failed, empty]) {
      assert.deepEqual(planGate(scope, ENV).map((s) => s.name), ['typecheck:node', 'typecheck:web', 'node', 'web']);
      assert.match(lines.join('\n'), /running the full gate/);
    }
    assert.match(failed.lines.join('\n'), /no main branch/);
    assert.match(empty.lines.join('\n'), /merge-base abc123/);
  });

  await t.test('--changed runs the whole suites its paths select, with their halves, and reports why', () => {
    const side = (files) => ({ files: new Set(files), text: '', walked: new Set() });
    const reach = { node: side([]), web: side(['web/src/b.ts']), stale: ['src/walker.ts'] };
    const { scope, lines } = changedGateScope({ ok: true, base: 'main', mergeBase: 'abc', paths: ['web/src/b.ts'] }, () => reach);
    const steps = planGate(scope, ENV);
    assert.deepEqual(steps.map((s) => s.name), ['typecheck:web', 'web']);
    assert.deepEqual(steps[1].args.slice(1), ['run', '--config', 'web/vitest.config.ts']);
    const text = lines.join('\n');
    assert.match(text, /web.*web\/src\/b\.ts/);
    assert.match(text, /stale WALKS_REVIEWED entry: src\/walker\.ts/);
    assert.doesNotMatch(text, /unclassified/);
    const unclassified = changedGateScope({ ok: true, base: 'main', mergeBase: 'abc', paths: ['zzz/unknown.txt'] }, () => reach);
    assert.match(unclassified.lines.join('\n'), /unclassified → everything: zzz\/unknown\.txt/);
    assert.deepEqual(planGate(unclassified.scope, ENV).map((s) => s.name), ['typecheck:node', 'typecheck:web', 'node', 'web']);
  });

  await t.test('package.json: no pretest, typecheck is the two halves, and each suite script starts with its half', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal('pretest' in scripts, false);
    assert.equal(scripts.test, 'node tests/gate.mjs');
    assert.equal(scripts.typecheck, 'npm run typecheck:node && npm run typecheck:web');
    assert.ok(scripts['test:node'].startsWith('npm run typecheck:node && '));
    assert.ok(scripts['test:web'].startsWith('npm run typecheck:web && '));
  });

  await t.test('a red blocking step starts no later step', async () => {
    const dir = mkdtempSync('cc-gate-');
    try {
      const marker = path.join(dir, 'ran');
      const steps = [{ ...fake('typecheck:node', 'process.exit(1)'), blocking: true },
        fake('node', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)];
      const results = await runSuites(steps);
      assert.ok(!fs.existsSync(marker), 'no step may start after a red blocking one');
      const { code, summary } = gateExit(steps, results);
      assert.equal(code, 1);
      assert.match(summary, /typecheck:node FAILED \(exit 1\) · node NOT RUN/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a green blocking step lets the next one run', async () => {
    const steps = [{ ...fake('typecheck:node', ''), blocking: true }, fake('node', '')];
    const { code, summary } = gateExit(steps, await runSuites(steps));
    assert.equal(code, 0);
    assert.match(summary, /typecheck:node PASSED · node PASSED/);
  });

  await t.test('a red second suite after a green first one reds the gate and is named', async () => {
    const suites = [fake('node', ''), fake('web', 'process.exit(1)')];
    const { code, summary } = gateExit(suites, await runSuites(suites));
    assert.notEqual(code, 0);
    assert.match(summary, /node PASSED/);
    assert.match(summary, /web FAILED \(exit 1\)/);
  });

  await t.test('a red first suite still runs the second', async () => {
    const dir = mkdtempSync('cc-gate-');
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
    const dir = mkdtempSync('cc-gate-');
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
    const dir = mkdtempSync('cc-gate-');
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
