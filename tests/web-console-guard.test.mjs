// The web Vitest suite drops the one happy-dom notice it cannot avoid
// (web/src/test/consoleGuard.ts) and nothing else. The proof fixture
// web/src/test/consoleGuard.proof.test.ts is run through Vitest and its
// output read back. The guard that fails a web test on console.error /
// console.warn (installConsoleGuard) is proved through the two
// consoleGuard.{raise,outside}.proof.test.ts fixtures and Vitest's JSON report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

test('the happy-dom iframe-disabled notice is not printed; an unrelated raw-console error still is; the run is green', () => {
  const r = spawnSync(process.execPath, [
    vitestBin, 'run', '--config', 'web/vitest.config.ts', 'src/test/consoleGuard.proof.test.ts',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CC_CONSOLE_GUARD_PROOF: '1' } });
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 0, `the run is green:\n${output}`);
  assert.match(output, /Tests\s+2 passed/, 'premise: both proof tests ran');
  assert.match(output, /guard-proof-marker/, 'an unrelated raw-console error is still printed');
  assert.doesNotMatch(output, /Iframe page loading is disabled/, 'the notice is dropped');
});

test('a console.error / console.warn fails the test or file it lands in; a spy opt-out is scoped to its test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-console-guard-'));
  const outputFile = path.join(dir, 'report.json');
  try {
    const r = spawnSync(process.execPath, [
      vitestBin, 'run', '--config', 'web/vitest.config.ts',
      'src/test/consoleGuard.raise.proof.test.ts', 'src/test/consoleGuard.outside.proof.test.ts',
      '--reporter=json', `--outputFile=${outputFile}`,
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CC_CONSOLE_GUARD_PROOF: '1' } });
    assert.ok(fs.existsSync(outputFile), `a report was written:\n${r.stdout}${r.stderr}`);
    const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    const file = (name) => report.testResults.find((f) => f.name.endsWith(name));
    const raise = file('consoleGuard.raise.proof.test.ts');
    const outside = file('consoleGuard.outside.proof.test.ts');
    const byTitle = (f) => new Map(f.assertionResults.map((a) => [a.title, a]));
    const tests = byTitle(raise);
    const failure = (title) => {
      const t = tests.get(title);
      assert.ok(t, `premise: "${title}" ran`);
      assert.equal(t.status, 'failed', `"${title}" failed`);
      return t.failureMessages.join('\n');
    };
    const passes = (title) => {
      const t = tests.get(title);
      assert.ok(t, `premise: "${title}" ran`);
      assert.equal(t.status, 'passed', `"${title}" passed: ${(t.failureMessages ?? []).join('\n')}`);
    };

    assert.equal(raise.assertionResults.length, 13, 'premise: every raise-fixture test ran');
    assert.match(failure('logs an error'), /console\.error: in-test-error-marker 7/);
    assert.match(failure('logs a warning'), /console\.warn: in-test-warn-marker/);
    for (const title of ['is quiet', 'mutes with a spy it leaves installed', 'is quiet after a next-turn log',
      'leaves a timer that logs later', 'fakes timers and leaves them installed', 'runs under the fake timers left installed']) passes(title);
    assert.match(failure('logs after the previous test left its spy'), /after-leftover-spy-marker/);
    assert.match(failure('restores its own spy, then logs'), /after-restore-marker/);
    assert.match(failure('restores all mocks, then logs'), /after-restore-all-marker/);
    assert.match(failure('schedules a log on the next turn'), /next-turn-marker/);
    const late = failure('is running when the leaked timer fires');
    assert.match(late, /leaked-timer-marker/);
    assert.match(late, /consoleGuard\.raise\.proof\.test\.ts/, 'the stack names the scheduling file');

    assert.equal(outside.status, 'failed', 'output outside any test fails the file');
    assert.match(outside.message, /outside any test/);
    assert.match(outside.message, /import-time-marker/);
    assert.match(outside.message, /after-all-marker/);
    assert.deepEqual([...byTitle(outside).values()].map((a) => a.status), ['passed'], 'the outside fixture\'s own test passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing file afterEach skips the guard afterEach: its spy is still restored and its logs still fail the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-console-guard-'));
  const outputFile = path.join(dir, 'report.json');
  try {
    const r = spawnSync(process.execPath, [
      vitestBin, 'run', '--config', 'web/vitest.config.ts', 'src/test/consoleGuard.skipped.proof.test.ts',
      '--reporter=json', `--outputFile=${outputFile}`,
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CC_CONSOLE_GUARD_PROOF: '1' } });
    assert.ok(fs.existsSync(outputFile), `a report was written:\n${r.stdout}${r.stderr}`);
    const file = JSON.parse(fs.readFileSync(outputFile, 'utf8')).testResults[0];
    const [first, second, third] = file.assertionResults;
    assert.equal(file.assertionResults.length, 4, 'premise: every test ran');
    assert.equal(first.status, 'failed', 'premise: the file afterEach failed the first test');
    assert.match(first.failureMessages.join('\n'), /file-afterEach-threw/);
    assert.equal(second.status, 'failed', 'the spy did not outlive the test whose guard afterEach was skipped');
    assert.match(second.failureMessages.join('\n'), /after-skipped-marker/);
    assert.equal(third.status, 'passed');
    assert.equal(file.status, 'failed', 'the skipped test\'s logs fail the file');
    assert.match(file.message, /skipped-test-marker/);
    assert.match(file.message, /last-test-marker/, 'the last test has no next beforeEach, and its logs still fail the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
