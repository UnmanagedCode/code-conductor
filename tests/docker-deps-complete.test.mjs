// docker/deps-complete.mjs is the container entrypoint's "is node_modules
// installed?" probe: a thin wrapper over src/depsDrift.ts that exits 0 only when
// node_modules matches package-lock.json, so a node_modules installed before a
// dependency was added or bumped gets repaired. The entrypoint's deps block is
// run here too, with a stub npm on PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(__dirname, '..', 'docker', 'deps-complete.mjs');
const ENTRYPOINT = path.resolve(__dirname, '..', 'docker', 'entrypoint.sh');
const DRIFT = path.resolve(__dirname, '..', 'src', 'depsDrift.ts');

// A checkout locking runtime a@1.0.0 and b@2.0.0 plus the dev-only d@1.0.0, with
// `installed` (name → version) on disk. The probe and the module it imports are
// copied in at their repo-relative paths, as the entrypoint runs them.
const LOCK = { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/d': { version: '1.0.0', dev: true } };
function checkout(installed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-complete-'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...LOCK } }));
  for (const [d, version] of Object.entries(installed)) {
    fs.mkdirSync(path.join(dir, 'node_modules', d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', d, 'package.json'), JSON.stringify({ name: d, version }));
  }
  fs.mkdirSync(path.join(dir, 'docker'));
  fs.copyFileSync(PROBE, path.join(dir, 'docker', 'deps-complete.mjs'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(DRIFT, path.join(dir, 'src', 'depsDrift.ts'));
  return dir;
}
const probe = (dir) => spawnSync(process.execPath, ['docker/deps-complete.mjs'], { cwd: dir, encoding: 'utf8' });

test('the probe exits 1 naming the offender on a drifted node_modules, 0 on an in-sync one', async (t) => {
  const dirs = [];
  t.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const run = (installed) => { const d = checkout(installed); dirs.push(d); return probe(d); };

  await t.test('a runtime dependency missing', () => {
    const r = run({ a: '1.0.0' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /node_modules\/b missing/);
  });
  await t.test('a runtime dependency at another version than the lock', () => {
    const r = run({ a: '1.0.0', b: '1.9.0' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /node_modules\/b 1\.9\.0 ≠ lock 2\.0\.0/);
  });
  await t.test('every runtime dependency at its locked version, no dev package (an --omit=dev install)', () => {
    const r = run({ a: '1.0.0', b: '2.0.0' });
    assert.equal(r.status, 0, r.stderr);
  });
  await t.test('a full install with the dev package too', () => {
    const r = run({ a: '1.0.0', b: '2.0.0', d: '1.0.0' });
    assert.equal(r.status, 0, r.stderr);
  });
});

test('a dependency directory with no package.json in it (an interrupted install) is incomplete', (t) => {
  const dir = checkout({ a: '1.0.0', b: '2.0.0' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.rmSync(path.join(dir, 'node_modules', 'b', 'package.json'));
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'b')), 'fixture check: the directory itself is still there');

  const r = probe(dir);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
});

test("the entrypoint runs the probe from the checkout and, only when it fails, runs npm install --omit=dev", (t) => {
  // The entrypoint's deps block as shipped: from its heading up to the exec.
  const script = fs.readFileSync(ENTRYPOINT, 'utf8');
  const start = script.indexOf('# ── Deps, then exec');
  const end = script.indexOf('exec ./conductor.sh');
  assert.ok(start !== -1 && end > start, 'fixture check: the deps block is found');
  const block = script.slice(start, end);

  const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-npm-'));
  const npmLog = path.join(stubs, 'npm.log');
  fs.writeFileSync(path.join(stubs, 'npm'), `#!/bin/sh\necho "$*" >> "${npmLog}"\n`, { mode: 0o755 });
  const partial = checkout({ a: '1.0.0' });
  const full = checkout({ a: '1.0.0', b: '2.0.0' });
  t.after(() => { for (const d of [stubs, partial, full]) fs.rmSync(d, { recursive: true, force: true }); });

  const run = (repoDir) => {
    fs.rmSync(npmLog, { force: true });
    const r = spawnSync('bash', ['-c', `set -euo pipefail\nfatal() { echo "FATAL $*" >&2; exit 1; }\nREPO_DIR=${JSON.stringify(repoDir)}\n${block}`], {
      encoding: 'utf8', env: { ...process.env, PATH: `${stubs}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    return fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim() : null;
  };
  assert.match(run(partial) ?? '', /^install --omit=dev\b/, 'a missing dependency installs the runtime deps');
  assert.equal(run(full), null, 'a complete node_modules installs nothing');
});
