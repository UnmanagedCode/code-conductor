// Unit tests for src/claudeShellEnv.js — the per-claude-version shell-env
// bundle cache used by the project_bash MCP tool. Server-less (no
// bootServer): a fake `claude` binary drives every codepath deterministically
// via env-var-selected modes, following the writeFake/withEnv pattern from
// tests/health.test.mjs. One real-binary smoke test at the bottom, gated
// behind RUN_REAL_CLAUDE=1, validates the approach against the actual
// installed `claude` CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { getShellEnvBundlePath, _resetForTest } from '../src/claudeShellEnv.js';
import { orchStoreRoot } from '../src/projects.js';

const execFileP = promisify(execFile);

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

async function mkTmp(prefix = 'cc-shellenv-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Modes (via FAKE_CLAUDE_MODE): happy | empty | nomarker | nonzero | hang | versionfail
const FAKE_CLAUDE_SCRIPT = `
import { writeFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'happy';
const version = process.env.FAKE_CLAUDE_VERSION || '9.9.9';

if (argv.includes('--version')) {
  if (mode === 'versionfail') process.exit(1);
  const vCounterFile = process.env.FAKE_CLAUDE_VERSION_COUNTER_FILE;
  if (vCounterFile) {
    let n = 0;
    try { n = parseInt(readFileSync(vCounterFile, 'utf8'), 10) || 0; } catch {}
    writeFileSync(vCounterFile, String(n + 1));
  }
  process.stdout.write(version + ' (Claude Code)\\n');
  process.exit(0);
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const counterFile = process.env.FAKE_CLAUDE_COUNTER_FILE;
  if (counterFile) {
    let n = 0;
    try { n = parseInt(readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
    writeFileSync(counterFile, String(n + 1));
  }
  const m = input.match(/> '([^']*)'/);
  const targetPath = m ? m[1] : null;

  const run = () => {
    if (mode === 'nonzero') { process.exit(1); return; }
    if (mode === 'hang') { setInterval(() => {}, 1e9); return; }
    if (mode === 'empty') { if (targetPath) writeFileSync(targetPath, ''); process.exit(0); return; }
    if (mode === 'nomarker') { if (targetPath) writeFileSync(targetPath, 'hello world, no marker here\\n'); process.exit(0); return; }
    if (targetPath) writeFileSync(targetPath, 'export CLAUDE_CODE_EXECPATH=/fake/claude\\nrg() { echo "RG-SHIM-CALLED $*"; }\\n');
    process.exit(0);
  };

  const delay = parseInt(process.env.FAKE_CLAUDE_DELAY_MS || '0', 10);
  if (delay > 0) setTimeout(run, delay);
  else run();
});
`;

async function writeFakeClaude(home) {
  const p = path.join(home, 'fake-claude.mjs');
  await fsp.writeFile(p, FAKE_CLAUDE_SCRIPT, 'utf8');
  return `${process.execPath} ${p}`;
}

test('happy path: resolves to an existing, validated bundle file', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    const p = await getShellEnvBundlePath();
    const contents = await fsp.readFile(p, 'utf8');
    assert.match(contents, /CLAUDE_CODE_EXECPATH/);
  });
});

test('disk-cache hit avoids a second generation, and the in-memory singleton avoids repeat --version calls', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  const counterFile = path.join(home, 'counter.txt');
  const versionCounterFile = path.join(home, 'version-counter.txt');
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9',
    FAKE_CLAUDE_COUNTER_FILE: counterFile,
    FAKE_CLAUDE_VERSION_COUNTER_FILE: versionCounterFile,
  }, async () => {
    _resetForTest();
    const paths = [];
    for (let i = 0; i < 5; i++) paths.push(await getShellEnvBundlePath());
    assert.ok(paths.every((p) => p === paths[0]));
    const count = await fsp.readFile(counterFile, 'utf8');
    assert.equal(count, '1');
    const versionCount = await fsp.readFile(versionCounterFile, 'utf8');
    assert.equal(versionCount, '1', 'claude --version should be spawned at most once per process lifetime');
  });
});

test('concurrent first-callers coalesce into a single generation', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  const counterFile = path.join(home, 'counter.txt');
  const versionCounterFile = path.join(home, 'version-counter.txt');
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9',
    FAKE_CLAUDE_COUNTER_FILE: counterFile, FAKE_CLAUDE_DELAY_MS: '150',
    FAKE_CLAUDE_VERSION_COUNTER_FILE: versionCounterFile,
  }, async () => {
    _resetForTest();
    const [p1, p2] = await Promise.all([getShellEnvBundlePath(), getShellEnvBundlePath()]);
    assert.equal(p1, p2);
    const count = await fsp.readFile(counterFile, 'utf8');
    assert.equal(count, '1');
    // The singleton is assigned synchronously to the first caller before
    // either awaits anything, so the second concurrent caller never even
    // reaches resolveClaudeBin()/getClaudeVersionKey() — only one --version
    // spawn total, not one per caller.
    const versionCount = await fsp.readFile(versionCounterFile, 'utf8');
    assert.equal(versionCount, '1');
  });
});

test('empty generated output fails validation and leaves no cache file', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'empty', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /empty|validation/i);
    const finalPath = path.join(orchStoreRoot(), 'shell-env', 'bundle-9.9.9.sh');
    await assert.rejects(() => fsp.stat(finalPath));
  });
});

test('missing CLAUDE_CODE_EXECPATH marker fails validation and leaves no cache file', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'nomarker', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /CLAUDE_CODE_EXECPATH|validation/i);
    const finalPath = path.join(orchStoreRoot(), 'shell-env', 'bundle-9.9.9.sh');
    await assert.rejects(() => fsp.stat(finalPath));
  });
});

test('non-zero exit from bundle generation rejects with the exit code', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'nonzero', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /exited with code 1/);
  });
});

test('generation timeout rejects quickly when claude never exits', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_VERSION: '9.9.9',
    CLAUDE_SHELL_ENV_TIMEOUT_MS: '200',
  }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /timed out/);
  });
});

test('claude --version failure rejects before attempting generation', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  const counterFile = path.join(home, 'counter.txt');
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'versionfail', FAKE_CLAUDE_COUNTER_FILE: counterFile,
  }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /version/i);
    // The -p codepath (which would create/increment this file) must never run.
    await assert.rejects(() => fsp.readFile(counterFile, 'utf8'), /ENOENT/);
  });
});

test('mid-lifetime version change is a no-op; only a restart (_resetForTest) generates a fresh bundle', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  const counterFile = path.join(home, 'counter.txt');
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '1.0.0',
    FAKE_CLAUDE_COUNTER_FILE: counterFile,
  }, async () => {
    _resetForTest();
    const p1 = await getShellEnvBundlePath();
    let count = await fsp.readFile(counterFile, 'utf8');
    assert.equal(count, '1');

    // Version flips mid-lifetime, but with no restart the in-memory
    // singleton must win — no re-check, no regeneration.
    process.env.FAKE_CLAUDE_VERSION = '2.0.0';
    const p2 = await getShellEnvBundlePath();
    assert.equal(p1, p2);
    count = await fsp.readFile(counterFile, 'utf8');
    assert.equal(count, '1');

    // Simulated daemon restart: only now does the new version take effect.
    _resetForTest();
    const p3 = await getShellEnvBundlePath();
    assert.notEqual(p1, p3);
    count = await fsp.readFile(counterFile, 'utf8');
    assert.equal(count, '2');
  });
});

test('claude --version failure does not permanently poison the cache', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'versionfail', FAKE_CLAUDE_VERSION: '9.9.9',
  }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /version/i);

    // No reset here — proving the failed resolution reset the memo itself.
    process.env.FAKE_CLAUDE_MODE = 'happy';
    const p = await getShellEnvBundlePath();
    const contents = await fsp.readFile(p, 'utf8');
    assert.match(contents, /CLAUDE_CODE_EXECPATH/);
  });
});

// ---- Real-binary smoke test ----
// Gated behind RUN_REAL_CLAUDE=1 — spawns the actually-installed `claude`
// CLI, generates a real bundle, and proves sourcing it restores rg/find as
// shell functions. This is the one test validating the whole approach
// against real model behavior; everything above is fake-binary-driven.
const ENABLED = !!process.env.RUN_REAL_CLAUDE;
const t = ENABLED ? test : test.skip.bind(test);

t('real claude: generated bundle restores rg/find as shell functions', async () => {
  const home = await mkTmp();
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: undefined }, async () => {
    _resetForTest();
    const bundlePath = await getShellEnvBundlePath();
    const script = `unset CLAUDE_CODE_EXECPATH; source ${bundlePath}; type rg; type find`;
    const { stdout } = await execFileP('bash', ['--noprofile', '--norc', '-c', script]);
    assert.match(stdout, /rg is a function/);
    assert.match(stdout, /find is a function/);
  });
});
