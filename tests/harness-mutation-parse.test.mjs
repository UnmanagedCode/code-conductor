// The mutation harness's Playwright route (harness/mutation/playwright.ts,
// bound by parse.mjs): reading Playwright's JSON report into a counted result,
// the route's canary, and the contract harness/mutation/config.json keeps with
// them. Pure — the plugin is not loaded, and the raw reports are captured real
// ones (tests/fixtures/mutation/PROVENANCE.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parsePlaywrightReport, canaryFor, FIRST_ERROR_MAX_BYTES, pwProject, DEFAULT_PW_PROJECT, PW_REPORT_FILE,
} from '../harness/mutation/playwright.ts';
import * as binding from '../harness/mutation/parse.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const FIX = path.join(import.meta.dirname, 'fixtures', 'mutation');
const raw = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const load = (name) => JSON.parse(raw(name));
const read = (report, project = 'desktop', exitCode = 1) =>
  parsePlaywrightReport(JSON.stringify(report), { cwd: '/repo', project, exitCode });
const config = JSON.parse(fs.readFileSync(path.join(REPO, 'harness', 'mutation', 'config.json'), 'utf8'));
const route = (name) => config.routes.find((r) => r.name === name);

// Pins: a failed Playwright test is named by its project-prefixed repo-relative id and counted once.
test('Playwright: counts, project-prefixed repo-relative ids and the reported files', () => {
  const r = read(load('pw-desktop-fail.json'));
  assert.deepEqual({ passed: r.passed, failed: r.failed, skipped: r.skipped, ran: r.ran, compileError: r.compileError },
    { passed: 1, failed: 2, skipped: 1, ran: 4, compileError: false });
  assert.deepEqual(r.failedTests, [
    { file: 'web/e2e/mixed.spec.ts', name: 'desktop > top fails', id: 'web/e2e/mixed.spec.ts::desktop > top fails' },
    { file: 'web/e2e/mixed.spec.ts', name: 'desktop > outer > inner > deep fails',
      id: 'web/e2e/mixed.spec.ts::desktop > outer > inner > deep fails' },
  ]);
  assert.deepEqual(r.files, ['web/e2e/mixed.spec.ts']);
  assert.equal(r.counts.project, 'desktop');
  assert.equal(r.counts.exitCode, 1);
  assert.equal(r.diagnostic, null);

  const deep = read(load('pw-desktop-pass.json'), 'desktop', 0);
  assert.deepEqual({ passed: deep.passed, failed: deep.failed, ran: deep.ran, files: deep.files },
    { passed: 1, failed: 0, ran: 1, files: ['web/e2e/legacy/deep.spec.ts'] });
});

// Pins: a load error is a compile error that ran nothing, with a bounded first error.
test('Playwright: a load error is a compile error with ran 0 and a bounded firstError', () => {
  const r = read(load('pw-desktop-load.json'));
  assert.equal(r.compileError, true);
  assert.equal(r.ran, 0);
  assert.equal(r.counts.errors, 1);
  assert.match(r.counts.firstError, /Cannot find module '\.\/does-not-exist\.ts'/);
  assert.ok(Buffer.byteLength(r.counts.firstError) <= FIRST_ERROR_MAX_BYTES);
});

// Pins: parse() reads the report from context.reports and relativises against context.cwd.
test('parse() reads playwright.json from context.reports and the paths against context.cwd', () => {
  const ok = binding.parse('', '', 1, { cwd: '/repo', reports: { [PW_REPORT_FILE]: raw('pw-desktop-fail.json') } });
  assert.equal(ok.failed, 2);
  assert.equal(ok.failedTests[0].id, 'web/e2e/mixed.spec.ts::desktop > top fails');
  // A different root puts the specs outside it: nothing reads as a pass.
  const moved = binding.parse('', '', 1, { cwd: '/elsewhere', reports: { [PW_REPORT_FILE]: raw('pw-desktop-fail.json') } });
  assert.equal(moved.ran, 0);
  assert.deepEqual(moved.files, []);
});

// Pins: a run that wrote no report reads ran 0 and names the flag, never a pass.
test('a missing or unparseable report reads ran 0 with a diagnostic', async (t) => {
  await t.test('missing', () => {
    const r = binding.parse('', '', 1, { cwd: '/repo', reports: {} });
    assert.equal(r.ran, 0);
    assert.deepEqual(r.files, []);
    assert.match(r.diagnostic, /PLAYWRIGHT_JSON_OUTPUT_FILE/);
    assert.match(r.diagnostic, /CC_MUTATION_PW_PROJECT/);
  });
  await t.test('not JSON', () => {
    const r = parsePlaywrightReport('{nope', { cwd: '/repo', project: 'desktop', exitCode: 1 });
    assert.equal(r.ran, 0);
    assert.match(r.diagnostic, /not JSON/);
  });
});

// Pins: a spec outside web/e2e/ fails closed instead of counting.
test('a spec outside web/e2e/ reads ran 0 with a diagnostic', () => {
  const r = parsePlaywrightReport(raw('pw-desktop-pass.json'), { cwd: '/repo/web', project: 'desktop', exitCode: 0 });
  assert.equal(r.ran, 0);
  assert.deepEqual(r.files, []);
  assert.match(r.diagnostic, /not a web\/e2e\/\*\*\/\*\.spec\.ts/);
});

// Pins: a test of another project than the pinned one fails closed.
test('a test whose projectName is not the pinned project reads ran 0', () => {
  const r = read(load('pw-desktop-fail.json'), 'phone');
  assert.equal(r.ran, 0);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.files, []);
  assert.match(r.diagnostic, /project desktop, not phone/);
});

// Pins: "No tests found" is reported with a pointer at the project selection, and the spec is absent from files.
test('a "No tests found" report names CC_MUTATION_PW_PROJECT', () => {
  const report = { config: { rootDir: '/repo/web/e2e' }, suites: [], errors: [{ message: 'Error: No tests found.\nMake sure that arguments are regular expressions' }] };
  const r = read(report);
  assert.equal(r.ran, 0);
  assert.deepEqual(r.files, []);
  assert.match(r.diagnostic, /CC_MUTATION_PW_PROJECT/);
});

// Pins: firstError is exactly the first FIRST_ERROR_MAX_BYTES bytes, cut on a character boundary.
test('Playwright: firstError is the first FIRST_ERROR_MAX_BYTES bytes of an over-long error, exactly', async (t) => {
  const withError = (message) => {
    const report = load('pw-desktop-load.json');
    report.errors = [{ message }, ...report.errors];
    return read(report).counts.firstError;
  };
  await t.test('one-byte characters', () => {
    const message = 'E'.repeat(FIRST_ERROR_MAX_BYTES * 3);
    const first = withError(message);
    assert.equal(Buffer.byteLength(first), FIRST_ERROR_MAX_BYTES);
    assert.ok(message.startsWith(first));
  });
  await t.test('two-byte characters are cut on a character boundary at the byte cap', () => {
    const first = withError('é'.repeat(FIRST_ERROR_MAX_BYTES * 3));
    assert.equal(Buffer.byteLength(first), FIRST_ERROR_MAX_BYTES);
    assert.equal(first, 'é'.repeat(FIRST_ERROR_MAX_BYTES / 2));
  });
  await t.test('an error under the cap is kept whole', () => {
    assert.equal(withError('short error'), 'short error');
  });
});

// Pins: the pinned project comes from CC_MUTATION_PW_PROJECT and defaults to DEFAULT_PW_PROJECT.
test('pwProject defaults to the default project', () => {
  assert.equal(DEFAULT_PW_PROJECT, 'desktop');
  assert.equal(pwProject({}), DEFAULT_PW_PROJECT);
  assert.equal(pwProject({ CC_MUTATION_PW_PROJECT: '' }), DEFAULT_PW_PROJECT);
  assert.equal(pwProject({ CC_MUTATION_PW_PROJECT: 'android' }), 'android');
});

// Pins: the canary is a project-pinned test of the e2e fixtures' type, for a Playwright spec only.
test('the Playwright canary matches only the pinned project and declines other files', async (t) => {
  await t.test('shape', () => {
    const c = canaryFor('web/e2e/session.spec.ts', 'const x = 1;', { project: 'desktop' });
    assert.ok(c.content.startsWith('const x = 1;\n'));
    assert.match(c.content, /__codeMutantCanary\("code_mutant_canary_fires", \(\) => \{ throw new Error\("code-mutant canary"\); \}\);/);
    assert.equal(c.testId, 'web/e2e/session.spec.ts::desktop > code_mutant_canary_fires');
    assert.equal(c.matches({ name: 'desktop > code_mutant_canary_fires' }), true);
    assert.equal(c.matches({ name: 'phone > code_mutant_canary_fires' }), false);
    assert.equal(canaryFor('web/e2e/session.spec.ts', '', { project: 'android' }).matches({ name: 'android > code_mutant_canary_fires' }), true);
  });
  for (const spec of ['web/e2e/settings-models-layout.spec.ts', 'web/e2e/flows/header.spec.ts']) {
    await t.test(`its import resolves to the e2e fixtures from ${spec}`, () => {
      const m = /^import \{ test as __codeMutantCanary \} from '([^']+)';$/m.exec(canaryFor(spec, '', { project: 'desktop' }).content);
      assert.ok(m, 'the canary imports its test type');
      const target = path.resolve(REPO, path.dirname(spec), m[1]);
      assert.equal(path.relative(REPO, target).split(path.sep).join('/'), 'web/e2e/harness/fixtures.ts');
      assert.ok(fs.existsSync(target));
    });
  }
  for (const bad of ['src/x.ts', 'tests/a.test.mjs', 'web/src/a.test.tsx', 'web/e2e/harness/boot.ts']) {
    await t.test(`declines ${bad}`, () => assert.equal(canaryFor(bad, '', { project: 'desktop' }), null));
  }
});

// Pins: the binding exports what the plugin needs of a counted custom route, and no scopeOf.
test('parse.mjs binds the report file and keeps the narrow canary eligible', () => {
  assert.equal(binding.grade, 'counted');
  assert.equal(binding.readsReportDir, true);
  assert.ok(binding.REQUIRED_FLAGS.includes(`$CODE_MUTANT_REPORT_DIR/${PW_REPORT_FILE}`));
  assert.equal(typeof binding.canary, 'function');
  assert.equal(binding.scopeOf, undefined);
});

// Pins: the config keeps the typecheck out of every mutant command, and Playwright an opt-in route.
test('config.json: routes, the typecheck placement and the single opt-in custom route', async (t) => {
  await t.test('no route\'s testCommand typechecks or runs the npm test gate', () => {
    for (const r of config.routes) assert.doesNotMatch(r.testCommand, /typecheck|\btsc\b|npm test/, r.name);
  });
  await t.test('the node baselineCommand typechecks before the node suite', () => {
    const cmd = route('node').baselineCommand;
    assert.ok(cmd.includes('npm run typecheck'));
    assert.ok(cmd.indexOf('npm run typecheck') < cmd.indexOf('node tests/run.mjs'));
  });
  await t.test('both vitest commands write the report into the report dir', () => {
    for (const cmd of [route('vitest').baselineCommand, route('vitest').testCommand]) {
      assert.ok(cmd.includes('--reporter=json'));
      assert.ok(cmd.includes('--outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"'));
    }
  });
  await t.test('playwright is an opt-in custom route with no baselineCommand', () => {
    const pw = route('playwright');
    assert.equal(pw.runner, 'custom');
    assert.equal(pw.optIn, true);
    assert.equal('baselineCommand' in pw, false);
    assert.ok(pw.testCommand.includes(`$CODE_MUTANT_REPORT_DIR/${PW_REPORT_FILE}`));
    assert.ok(pw.testCommand.includes(`:-${DEFAULT_PW_PROJECT}}`));
    assert.ok(pw.testCommand.includes('{tests}'));
  });
  await t.test('exactly one route is custom', () => {
    assert.equal(config.routes.filter((r) => r.runner === 'custom').length, 1);
  });
  await t.test('no top-level runner or command beside routes', () => {
    for (const k of ['runner', 'baselineCommand', 'testCommand']) assert.equal(k in config, false, k);
  });
});
