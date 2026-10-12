// docker/deps-complete.mjs is the container entrypoint's "is node_modules
// installed?" probe: it exits 0 only when every runtime dependency in the
// checkout's package.json has a node_modules/<dep>/package.json, so a
// node_modules installed before a dependency was added gets repaired. The
// entrypoint's deps block is run here too, with a stub npm on PATH.

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

function checkout(installed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-complete-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '^1.0.0', b: '^2.0.0' } }));
  for (const d of installed) {
    fs.mkdirSync(path.join(dir, 'node_modules', d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', d, 'package.json'), JSON.stringify({ name: d }));
  }
  return dir;
}

test('a node_modules missing any runtime dependency is incomplete; one with all of them is complete', (t) => {
  const partial = checkout(['a']);
  const full = checkout(['a', 'b']);
  t.after(() => { fs.rmSync(partial, { recursive: true, force: true }); fs.rmSync(full, { recursive: true, force: true }); });

  const missing = spawnSync(process.execPath, [PROBE], { cwd: partial, encoding: 'utf8' });
  assert.equal(missing.status, 1, `partial install: ${missing.stderr}`);
  const complete = spawnSync(process.execPath, [PROBE], { cwd: full, encoding: 'utf8' });
  assert.equal(complete.status, 0, `full install: ${complete.stderr}`);
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
  const partial = checkout(['a']);
  const full = checkout(['a', 'b']);
  t.after(() => { for (const d of [stubs, partial, full]) fs.rmSync(d, { recursive: true, force: true }); });
  for (const dir of [partial, full]) {
    fs.mkdirSync(path.join(dir, 'docker'));
    fs.copyFileSync(PROBE, path.join(dir, 'docker', 'deps-complete.mjs'));
  }

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
