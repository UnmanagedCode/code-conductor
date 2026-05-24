import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkClaudeReadiness, formatReadiness } from '../src/health.js';

async function mkTmp(prefix = 'cc-health-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

async function writeFake(home, script) {
  const p = path.join(home, 'fake-claude.mjs');
  await fsp.writeFile(p, script, 'utf8');
  return `node ${p}`;
}

async function seedClaudeDir(home, { credentials = false } = {}) {
  await fsp.mkdir(path.join(home, '.claude'), { recursive: true });
  if (credentials) {
    await fsp.writeFile(path.join(home, '.claude', '.credentials.json'), '{}', 'utf8');
  }
}

test('happy path: bin works + credentials.json present', async () => {
  const home = await mkTmp();
  await seedClaudeDir(home, { credentials: true });
  const bin = await writeFake(home, `process.stdout.write('2.1.143 (Claude Code)\\n');`);
  await withEnv({ CLAUDE_BIN: bin, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 2000 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.issues, []);
    assert.equal(r.claudeBin.found, true);
    assert.equal(r.claudeBin.version, '2.1.143');
    assert.equal(r.claudeDir.exists, true);
    assert.equal(r.authenticated.ok, true);
    assert.equal(r.authenticated.source, 'credentials');
  });
});

test('bin missing (ENOENT) flags claude_bin_missing', async () => {
  const home = await mkTmp();
  await seedClaudeDir(home, { credentials: true });
  await withEnv({ CLAUDE_BIN: '/nonexistent/path/claude-xyz', ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.equal(r.claudeBin.found, false);
    assert.equal(r.claudeBin.error, 'enoent');
    const codes = r.issues.map(i => i.code);
    assert.ok(codes.includes('claude_bin_missing'));
  });
});

test('bin times out flags claude_bin_missing with error=timeout', async () => {
  const home = await mkTmp();
  await seedClaudeDir(home, { credentials: true });
  const bin = await writeFake(home, `setInterval(() => {}, 1000000);`);
  await withEnv({ CLAUDE_BIN: bin, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 250 });
    assert.equal(r.claudeBin.found, false);
    assert.equal(r.claudeBin.error, 'timeout');
    assert.ok(r.issues.some(i => i.code === 'claude_bin_missing'));
  });
});

test('bin exits non-zero flags claude_bin_missing with error=exit', async () => {
  const home = await mkTmp();
  await seedClaudeDir(home, { credentials: true });
  const bin = await writeFake(home, `process.exit(1);`);
  await withEnv({ CLAUDE_BIN: bin, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 2000 });
    assert.equal(r.claudeBin.found, false);
    assert.equal(r.claudeBin.error, 'exit');
    assert.equal(r.claudeBin.exitCode, 1);
    assert.ok(r.issues.some(i => i.code === 'claude_bin_missing'));
  });
});

test('auth via ANTHROPIC_API_KEY env, no credentials file', async () => {
  const home = await mkTmp();
  await seedClaudeDir(home, { credentials: false });
  const bin = await writeFake(home, `process.stdout.write('9.9.9\\n');`);
  await withEnv({ CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 2000 });
    assert.equal(r.authenticated.ok, true);
    assert.equal(r.authenticated.source, 'env');
    assert.ok(!r.issues.some(i => i.code === 'not_authenticated'));
  });
});

test('auth missing entirely flags not_authenticated', async () => {
  const home = await mkTmp();
  await seedClaudeDir(home, { credentials: false });
  const bin = await writeFake(home, `process.stdout.write('9.9.9\\n');`);
  await withEnv({ CLAUDE_BIN: bin, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 2000 });
    assert.equal(r.authenticated.ok, false);
    assert.equal(r.authenticated.source, null);
    assert.ok(r.issues.some(i => i.code === 'not_authenticated'));
  });
});

test('~/.claude missing flags both claude_dir_missing and not_authenticated', async () => {
  const home = await mkTmp();
  // No seedClaudeDir — empty home.
  const bin = path.join(home, 'fake-claude.mjs');
  await fsp.writeFile(bin, `process.stdout.write('9.9.9\\n');`, 'utf8');
  await withEnv({ CLAUDE_BIN: `node ${bin}`, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await checkClaudeReadiness({ home, timeoutMs: 2000 });
    const codes = r.issues.map(i => i.code);
    assert.ok(codes.includes('claude_dir_missing'));
    assert.ok(codes.includes('not_authenticated'));
    assert.equal(r.claudeDir.exists, false);
  });
});

test('formatReadiness — OK line includes version + auth source', () => {
  const out = formatReadiness({
    ok: true,
    claudeBin: { found: true, command: 'claude', version: '2.1.143' },
    claudeDir: { exists: true, path: '/x/.claude' },
    authenticated: { ok: true, source: 'credentials' },
    issues: [],
  });
  assert.match(out, /claude OK/);
  assert.match(out, /2\.1\.143/);
  assert.match(out, /credentials\.json/);
});

test('formatReadiness — warning block includes header, codes, and hints', () => {
  const out = formatReadiness({
    ok: false,
    claudeBin: { found: false, command: 'claude', error: 'enoent' },
    claudeDir: { exists: false, path: '/x/.claude' },
    authenticated: { ok: false, source: null },
    issues: [
      { code: 'claude_bin_missing', title: 'A', hint: 'fix bin' },
      { code: 'claude_dir_missing', title: 'B', hint: 'fix dir' },
      { code: 'not_authenticated', title: 'C', hint: 'sign in' },
    ],
  });
  assert.match(out, /WARNING/);
  assert.match(out, /claude_bin_missing/);
  assert.match(out, /claude_dir_missing/);
  assert.match(out, /not_authenticated/);
  assert.match(out, /fix bin/);
  assert.match(out, /sign in/);
});
