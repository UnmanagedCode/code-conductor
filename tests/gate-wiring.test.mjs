// The real gate's wiring of scopeOf: a copy of the gate (and the modules it
// imports) runs in a throwaway git repo on `main` with an npm stub, so the change
// set it sees is the repo's own. A typecheck-reachable change plans typecheck:node;
// a tests/-only change skips it and the gate prints the skip line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HELD_VAR } from './testSlot.mjs';
import { mkdtempSync } from './tmpRegistry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const COPIED = ['gate.mjs', 'changedScope.mjs', 'testSlot.mjs', 'poll.mjs'];

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

function fixtureRepo() {
  const root = mkdtempSync('cc-gate-wiring-');
  fs.mkdirSync(path.join(root, 'tests'));
  for (const f of COPIED) fs.copyFileSync(path.join(here, f), path.join(root, 'tests', f));
  fs.writeFileSync(path.join(root, 'tests', 'run.mjs'), '');
  fs.writeFileSync(path.join(root, 'npm-stub.mjs'), "console.log('STEP ' + process.argv.slice(2).join(' '));\n");
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.join(here, '..', 'node_modules'), path.join(root, 'node_modules'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return root;
}

async function runGate(root) {
  const port = await freePair();
  const env = { ...process.env, CC_TEST_SLOT_PORT: String(port), CC_TEST_SLOTS: '2', npm_execpath: path.join(root, 'npm-stub.mjs') };
  delete env[HELD_VAR];
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['tests/gate.mjs', 'tests/fx.test.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

test('a file-list gate run plans typecheck:node when the repo change set holds a typecheck-reachable path', async () => {
  const root = fixtureRepo();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'fx.ts'), 'export const x = 1;\n');
  const r = await runGate(root);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /STEP run typecheck:node/);
  assert.doesNotMatch(r.stdout, /typecheck:node skipped/);
});

test('a file-list gate run with a tests/-only change set skips typecheck:node and prints the skip line', async () => {
  const root = fixtureRepo();
  fs.writeFileSync(path.join(root, 'tests', 'fx.test.mjs'), '');
  const r = await runGate(root);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /STEP/);
  assert.match(r.stdout, /npm test: typecheck:node skipped/);
});
