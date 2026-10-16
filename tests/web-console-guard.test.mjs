// The web Vitest suite drops the one happy-dom notice it cannot avoid
// (web/src/test/consoleGuard.ts) and nothing else. The proof fixture
// web/src/test/consoleGuard.proof.test.ts is run through Vitest and its
// output read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
