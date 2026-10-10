// The mutation harness's scoring layer (harness/mutation/scoring.ts): routing a
// test file to its runner, the commands each mode runs, reducing Vitest and
// Playwright JSON reports to ids + statuses, merging the framed sections
// suite.ts prints into one counted result, and the per-runner canary. Pure — the
// node-test and vitest adapters are stubs here, and the raw reports are captured
// real ones (tests/fixtures/mutation/PROVENANCE.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  route, planCommands, reduceVitestReport, reducePlaywrightReport, playwrightReportFiles, parseSuiteOutput,
  canaryFor, listingSelects, frame, pwProject, DEFAULT_PW_PROJECT, TEST_FILE_PATTERNS,
} from '../harness/mutation/scoring.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const FIX = path.join(import.meta.dirname, 'fixtures', 'mutation');
const raw = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const load = (name) => JSON.parse(raw(name));
const PROJECTS = ['desktop', 'phone', 'android'];

const lsFiles = (...globs) => execFileSync('git', ['ls-files', '--', ...globs], { cwd: REPO, encoding: 'utf8' })
  .split('\n').filter(Boolean);

test('every file of each runner\'s discovery routes to exactly its group', async (t) => {
  const discovered = {
    node: lsFiles('tests/*.test.mjs').filter((f) => !f.slice('tests/'.length).includes('/')),
    vitest: lsFiles('web/src/**/*.test.ts', 'web/src/**/*.test.tsx'),
    playwright: lsFiles('web/e2e/**/*.spec.ts', 'web/e2e/*.spec.ts'),
  };
  for (const [group, files] of Object.entries(discovered)) {
    await t.test(group, () => {
      assert.ok(files.length > 0, `git ls-files found no ${group} test files`);
      const routed = route(files, REPO);
      assert.deepEqual([...routed.keys()], [group]);
      assert.deepEqual(routed.get(group), files);
    });
  }
});

test('route accepts an absolute path under the repo and refuses a non-test path', async (t) => {
  assert.deepEqual(route([path.join(REPO, 'tests/sidebar.test.mjs')], REPO).get('node'), ['tests/sidebar.test.mjs']);
  for (const bad of ['src/webBuild.ts', 'tests/helpers.mjs', 'tests/sub/x.test.mjs', 'web/src/main.tsx',
    'web/e2e/harness/boot.ts', 'web/src/x.spec.ts', '/elsewhere/tests/a.test.mjs']) {
    await t.test(bad, () => {
      assert.throws(() => route(['tests/sidebar.test.mjs', bad], REPO), (e) => {
        assert.ok(e.message.includes(bad), `the refusal does not name ${bad}`);
        assert.match(e.message, /tests\/<name>\.test\.mjs/);
        return true;
      });
    });
  }
});

test('planCommands: narrow mode never typechecks; --all typechecks first and runs no Playwright', async (t) => {
  const tmpDir = '/tmp/cc-mutation-suite-x';
  const groups = new Map([['node', ['tests/a.test.mjs']], ['vitest', ['web/src/b.test.ts']], ['playwright', ['web/e2e/c.spec.ts']]]);

  await t.test('narrow', () => {
    const cmds = planCommands('narrow', groups, { project: 'desktop', projects: PROJECTS, tmpDir });
    assert.deepEqual(cmds.map((c) => c.group), ['node', 'vitest', 'playwright']);
    const [node, vitest, pw] = cmds;
    assert.equal(node.cmd, 'npm');
    assert.deepEqual(node.args, ['test', '--ignore-scripts', '--', 'tests/a.test.mjs']);
    assert.equal(vitest.cmd, 'npx');
    assert.deepEqual(vitest.args, ['vitest', 'run', '--config', 'web/vitest.config.ts', '--reporter=json',
      `--outputFile=${vitest.report}`, 'web/src/b.test.ts']);
    assert.ok(path.isAbsolute(vitest.report) && vitest.report.startsWith(tmpDir + path.sep));
    assert.equal(vitest.env.NO_COLOR, '1');
    assert.equal(pw.cmd, 'npx');
    assert.deepEqual(pw.args, ['playwright', 'test', '--config', 'web/playwright.config.ts', '--project=desktop',
      '--reporter=json', 'web/e2e/c.spec.ts']);
    assert.equal(pw.env.PLAYWRIGHT_JSON_OUTPUT_FILE, pw.report);
    assert.ok(path.isAbsolute(pw.report) && pw.report.startsWith(tmpDir + path.sep));
    assert.equal(pw.env.NO_COLOR, '1');
    for (const c of cmds) assert.ok(!c.args.includes('typecheck'));
  });

  await t.test('--all', () => {
    const cmds = planCommands('all', new Map(), { project: 'desktop', projects: PROJECTS, tmpDir });
    assert.deepEqual(cmds.map((c) => c.group), ['typecheck', 'node', 'vitest']);
    assert.deepEqual(cmds[0].args, ['run', 'typecheck']);
    assert.deepEqual(cmds[1].args, ['test', '--ignore-scripts']);
    assert.ok(!cmds[2].args.some((a) => a.endsWith('.test.ts')));
  });

  await t.test('the Playwright project comes from the option and an unknown one is refused', () => {
    const phone = planCommands('narrow', new Map([['playwright', ['web/e2e/c.spec.ts']]]), { project: 'phone', projects: PROJECTS, tmpDir });
    assert.ok(phone[0].args.includes('--project=phone'));
    assert.throws(() => planCommands('narrow', groups, { project: 'tablet', projects: PROJECTS, tmpDir }),
      /tablet.*desktop, phone, android/);
  });

  await t.test('pwProject defaults to desktop', () => {
    assert.equal(DEFAULT_PW_PROJECT, 'desktop');
    assert.equal(pwProject({}), 'desktop');
    assert.equal(pwProject({ CC_MUTATION_PW_PROJECT: '' }), 'desktop');
    assert.equal(pwProject({ CC_MUTATION_PW_PROJECT: 'android' }), 'android');
  });
});

const stubNodeTest = {
  parse: () => { throw new Error('the stub node-test parser was called with no node section'); },
};

test('Vitest: reduce keeps the requested files, with exact repo-relative ids', () => {
  const report = load('vitest-mixed.json');
  const reduced = reduceVitestReport(report, '/repo', ['web/src/logic.test.ts', 'web/src/nested/load.test.ts']);
  assert.deepEqual(reduced, {
    files: [
      {
        file: 'web/src/logic.test.ts',
        loadFailed: false,
        tests: [
          { id: 'web/src/logic.test.ts::adds', status: 'passed' },
          { id: 'web/src/logic.test.ts::outer > inner > fails deep', status: 'failed' },
          { id: 'web/src/logic.test.ts::outer > inner > passes deep', status: 'passed' },
          { id: 'web/src/logic.test.ts::outer > skipped one', status: 'skipped' },
        ],
      },
      { file: 'web/src/nested/load.test.ts', loadFailed: true, tests: [] },
    ],
  });
  const line = JSON.stringify(reduced);
  assert.ok(!line.includes('/repo') && !line.includes('web/web/'), 'an id is absolute or double-prefixed');
  assert.ok(Buffer.byteLength(line) * 4 < Buffer.byteLength(raw('vitest-mixed.json')),
    `reduced ${Buffer.byteLength(line)} bytes is not a small fraction of ${Buffer.byteLength(raw('vitest-mixed.json'))}`);

  // With no requested files (--all) every file is kept, the .tsx sibling the
  // .test.ts filter over-matched included.
  assert.deepEqual(reduceVitestReport(report, '/repo', null).files.map((f) => f.file),
    ['web/src/logic.test.ts', 'web/src/logic.test.tsx', 'web/src/nested/load.test.ts']);
});

test('Vitest: parse counts, failed ids, and a load failure as a compile error', () => {
  const reduced = reduceVitestReport(load('vitest-mixed.json'), '/repo', ['web/src/logic.test.ts', 'web/src/nested/load.test.ts']);
  const out = frame('vitest exit=1', JSON.stringify(reduced));
  const r = parseSuiteOutput(out, '', 1, { nodeTest: stubNodeTest });
  assert.equal(r.grade, 'counted');
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.ran, 5);
  assert.deepEqual(r.failedTests, [
    { file: 'web/src/logic.test.ts', name: 'outer > inner > fails deep', id: 'web/src/logic.test.ts::outer > inner > fails deep' },
    { file: 'web/src/nested/load.test.ts', name: 'web/src/nested/load.test.ts', id: 'web/src/nested/load.test.ts' },
  ]);
  assert.equal(r.compileError, true);

  const pass = parseSuiteOutput(frame('vitest exit=0', JSON.stringify(reduceVitestReport(load('vitest-pass.json'), '/repo', ['web/src/pass.test.ts']))), '', 0, { nodeTest: stubNodeTest });
  assert.deepEqual({ passed: pass.passed, failed: pass.failed, ran: pass.ran, compileError: pass.compileError, failedTests: pass.failedTests },
    { passed: 1, failed: 0, ran: 1, compileError: false, failedTests: [] });
});

test('Playwright: reduce gives project-prefixed repo-relative ids and drops everything else', () => {
  const report = load('pw-desktop-fail.json');
  const reduced = reducePlaywrightReport(report, '/repo', ['web/e2e/mixed.spec.ts'], 'desktop');
  assert.deepEqual(reduced, {
    project: 'desktop',
    errors: 0,
    firstError: null,
    tests: [
      { id: 'web/e2e/mixed.spec.ts::desktop > top passes', status: 'expected' },
      { id: 'web/e2e/mixed.spec.ts::desktop > top fails', status: 'unexpected' },
      { id: 'web/e2e/mixed.spec.ts::desktop > outer > skipped one', status: 'skipped' },
      { id: 'web/e2e/mixed.spec.ts::desktop > outer > inner > deep fails', status: 'unexpected' },
    ],
  });
  const line = JSON.stringify(reduced);
  assert.ok(!line.includes('/repo') && !line.includes('web/web/'));
  assert.ok(Buffer.byteLength(line) * 10 < Buffer.byteLength(raw('pw-desktop-fail.json')),
    `reduced ${Buffer.byteLength(line)} bytes is not a small fraction of ${Buffer.byteLength(raw('pw-desktop-fail.json'))}`);

  const deep = reducePlaywrightReport(load('pw-desktop-pass.json'), '/repo', ['web/e2e/legacy/deep.spec.ts'], 'desktop');
  assert.deepEqual(deep.tests, [{ id: 'web/e2e/legacy/deep.spec.ts::desktop > legacy deep passes', status: 'expected' }]);
  assert.deepEqual(playwrightReportFiles(load('pw-desktop-pass.json'), '/repo'), ['web/e2e/legacy/deep.spec.ts']);
  assert.deepEqual(reducePlaywrightReport(report, '/repo', ['web/e2e/other.spec.ts'], 'desktop').tests, []);
});

test('Playwright: a file outside web/e2e/ is refused', () => {
  const report = load('pw-desktop-pass.json');
  assert.throws(() => reducePlaywrightReport(report, '/repo/web', null, 'desktop'), /e2e\/legacy\/deep\.spec\.ts.*web\/e2e\//);
});

test('Playwright: parse counts, failed ids, and a load error as a compile error', () => {
  const fail = reducePlaywrightReport(load('pw-desktop-fail.json'), '/repo', ['web/e2e/mixed.spec.ts'], 'desktop');
  const r = parseSuiteOutput(frame('playwright project=desktop exit=1', JSON.stringify(fail)), '', 1, { nodeTest: stubNodeTest });
  assert.deepEqual({ passed: r.passed, failed: r.failed, skipped: r.skipped, ran: r.ran, compileError: r.compileError },
    { passed: 1, failed: 2, skipped: 1, ran: 4, compileError: false });
  assert.deepEqual(r.failedTests.map((f) => f.id), [
    'web/e2e/mixed.spec.ts::desktop > top fails',
    'web/e2e/mixed.spec.ts::desktop > outer > inner > deep fails',
  ]);
  assert.equal(r.failedTests[0].file, 'web/e2e/mixed.spec.ts');
  assert.equal(r.failedTests[0].name, 'desktop > top fails');

  const loadErr = reducePlaywrightReport(load('pw-desktop-load.json'), '/repo', ['web/e2e/load.spec.ts', 'web/e2e/mixed.spec.ts'], 'desktop');
  assert.equal(loadErr.errors, 1);
  assert.match(loadErr.firstError, /Cannot find module '\.\/does-not-exist\.ts'/);
  assert.ok(Buffer.byteLength(loadErr.firstError) <= 2048);
  const e = parseSuiteOutput(frame('playwright project=desktop exit=1', JSON.stringify(loadErr)), '', 1, { nodeTest: stubNodeTest });
  assert.equal(e.compileError, true);
  assert.equal(e.ran, 0);
});

test('a --list report tells a project that does not select a spec from a spec that fails to load', async (t) => {
  // Playwright reports an empty selection as an error too, so the run report
  // alone cannot tell a refusal (wrong project) from a compile error.
  await t.test('selected', () => assert.equal(listingSelects(load('pw-list-selected.json'), '/repo', 'web/e2e/switch.spec.ts'), true));
  await t.test('not selected: a refusal', () => assert.equal(listingSelects(load('pw-list-not-selected.json'), '/repo', 'web/e2e/switch.spec.ts'), false));
  await t.test('load error: undecided, so the compile-error reading stands', () =>
    assert.equal(listingSelects(load('pw-list-load.json'), '/repo', 'web/e2e/zz-load.spec.ts'), null));
  await t.test('no report: undecided', () => assert.equal(listingSelects(null, '/repo', 'web/e2e/switch.spec.ts'), null));
});

test('sections merge: node via the injected parser, summed with Vitest and Playwright', () => {
  const calls = [];
  const nodeTest = {
    parse: (stdout, stderr, exit) => {
      calls.push({ stdout, stderr, exit });
      return { grade: 'counted', passed: 3, failed: 1, skipped: 0, ran: 4, compileError: false, counts: {},
        failedTests: [{ file: 'tests/a.test.mjs', name: 'x', id: 'tests/a.test.mjs::x' }] };
    },
  };
  const vitest = reduceVitestReport(load('vitest-pass.json'), '/repo', ['web/src/pass.test.ts']);
  const pw = reducePlaywrightReport(load('pw-desktop-fail.json'), '/repo', ['web/e2e/mixed.spec.ts'], 'desktop');
  const out = [
    frame('node-stdout exit=1', 'ℹ tests 4\nline two'),
    frame('node-stderr', 'some stderr'),
    frame('vitest exit=0', JSON.stringify(vitest)),
    frame('playwright project=desktop exit=1', JSON.stringify(pw)),
  ].join('');
  const r = parseSuiteOutput(out, 'outer stderr is not a section', 1, { nodeTest });
  assert.deepEqual(calls, [{ stdout: 'ℹ tests 4\nline two', stderr: 'some stderr', exit: 1 }]);
  assert.deepEqual({ passed: r.passed, failed: r.failed, skipped: r.skipped, ran: r.ran, compileError: r.compileError },
    { passed: 3 + 1 + 1, failed: 1 + 0 + 2, skipped: 1, ran: 4 + 1 + 4, compileError: false });
  assert.deepEqual(r.failedTests.map((f) => f.id), [
    'tests/a.test.mjs::x',
    'web/e2e/mixed.spec.ts::desktop > top fails',
    'web/e2e/mixed.spec.ts::desktop > outer > inner > deep fails',
  ]);
});

test('a missing section contributes nothing, so a refusal reads ran 0', () => {
  const r = parseSuiteOutput('', 'web/e2e/x.spec.ts is not in project android', 2, { nodeTest: stubNodeTest });
  assert.deepEqual({ ran: r.ran, failed: r.failed, passed: r.passed, compileError: r.compileError, failedTests: r.failedTests },
    { ran: 0, failed: 0, passed: 0, compileError: false, failedTests: [] });
});

test('typecheck exit≠0 is a compile error; exit=0 is not', () => {
  const nodeTest = { parse: () => ({ grade: 'counted', passed: 1, failed: 0, skipped: 0, ran: 1, compileError: false, counts: {}, failedTests: [] }) };
  const node = frame('node-stdout exit=0', 'ok') + frame('node-stderr', '');
  assert.equal(parseSuiteOutput(frame('typecheck exit=2', 'error TS2322: …') + node, '', 1, { nodeTest }).compileError, true);
  assert.equal(parseSuiteOutput(frame('typecheck exit=0', '') + node, '', 0, { nodeTest }).compileError, false);
});

test('canaryFor dispatches by test file; the Playwright canary matches only the pinned project', async (t) => {
  const deps = (project) => ({
    nodeTest: { canary: (source, { file }) => ({ content: `node:${source}`, testId: `${file}::node`, matches: () => 'node' }) },
    vitest: { canary: (source, { file }) => ({ content: `vitest:${source}`, testId: `${file}::vitest`, matches: () => 'vitest' }) },
    label: 'code_mutant_canary',
    message: 'code-mutant canary',
    project,
  });

  await t.test('node', () => assert.equal(canaryFor('tests/a.test.mjs', 'S', deps('desktop')).content, 'node:S'));
  await t.test('vitest', () => assert.equal(canaryFor('web/src/a.test.tsx', 'S', deps('desktop')).content, 'vitest:S'));
  await t.test('playwright', () => {
    const c = canaryFor('web/e2e/session.spec.ts', 'const x = 1;', deps('desktop'));
    assert.ok(c.content.startsWith('const x = 1;\n'));
    assert.match(c.content, /import \{ test as __codeMutantCanary \} from '@playwright\/test';/);
    assert.match(c.content, /__codeMutantCanary\("code_mutant_canary_fires", \(\) => \{ throw new Error\("code-mutant canary"\); \}\);/);
    assert.equal(c.testId, 'web/e2e/session.spec.ts::desktop > code_mutant_canary_fires');
    assert.equal(c.matches({ name: 'desktop > code_mutant_canary_fires' }), true);
    assert.equal(c.matches({ name: 'phone > code_mutant_canary_fires' }), false);
    assert.equal(canaryFor('web/e2e/session.spec.ts', '', deps('android')).matches({ name: 'android > code_mutant_canary_fires' }), true);
  });
  await t.test('a non-test file is refused', () => assert.throws(() => canaryFor('src/x.ts', '', deps('desktop')), /src\/x\.ts/));
});

test('TEST_FILE_PATTERNS name the baseline\'s two suites and no Playwright spec', () => {
  assert.deepEqual(TEST_FILE_PATTERNS, ['tests/*.test.mjs', 'web/src/**/*.test.ts', 'web/src/**/*.test.tsx']);
});
