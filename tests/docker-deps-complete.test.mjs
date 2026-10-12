// docker/deps-complete.mjs is the container entrypoint's "is node_modules
// installed?" probe: it exits 0 only when every runtime dependency in the
// checkout's package.json has a node_modules/<dep>/package.json, so a
// node_modules installed before a dependency was added gets repaired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(__dirname, '..', 'docker', 'deps-complete.mjs');

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
