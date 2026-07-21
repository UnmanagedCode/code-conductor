// Unit tests for src/claudeShellEnv.js — the per-claude-version shell-env
// bundle cache used by the project_bash MCP tool. Server-less (no
// bootServer): a fake `claude` binary drives every codepath deterministically
// via env-var-selected modes, following the writeFake/withEnv pattern from
// tests/health.test.mjs. Two real-binary smoke tests at the bottom — gated
// behind RUN_REAL_CLAUDE=1 (claude) and RUN_REAL_OLLAMA=1 (ollama) — validate
// the approach against the actual installed CLIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { getShellEnvBundlePath, _resetForTest, bundleShellKind } from '../src/claudeShellEnv.js';
import { orchStoreRoot } from '../src/projects.js';
import { setTierBackend } from '../src/appSettings.js';
import { fakeOllamaReachable, fakeOllamaUnreachable } from './helpers.mjs';
import { resolveBackendLaunch } from '../src/claudeLauncher.js';

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

// Modes (via FAKE_CLAUDE_MODE): happy | empty | nomarker | noshellkind | nonzero | hang | versionfail
const FAKE_CLAUDE_SCRIPT = `
import { writeFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'happy';
const version = process.env.FAKE_CLAUDE_VERSION || '9.9.9';
const shellKind = process.env.FAKE_CLAUDE_SHELL_KIND || 'bash';

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
  const argvFile = process.env.FAKE_CLAUDE_ARGV_FILE;
  if (argvFile) writeFileSync(argvFile, JSON.stringify(argv));
  const m = input.match(/> '([^']*)'/);
  const targetPath = m ? m[1] : null;

  const run = () => {
    if (mode === 'nonzero') { process.exit(1); return; }
    if (mode === 'hang') { setInterval(() => {}, 1e9); return; }
    if (mode === 'empty') { if (targetPath) writeFileSync(targetPath, ''); process.exit(0); return; }
    if (mode === 'nomarker') { if (targetPath) writeFileSync(targetPath, 'hello world, no marker here\\n'); process.exit(0); return; }
    if (mode === 'noshellkind') { if (targetPath) writeFileSync(targetPath, 'export CLAUDE_CODE_EXECPATH=/fake/claude\\nrg() { echo "RG-SHIM-CALLED $*"; }\\n'); process.exit(0); return; }
    if (targetPath) writeFileSync(targetPath, 'export CLAUDE_CODE_EXECPATH=/fake/claude\\nexport CLAUDE_CODE_SHELL_KIND=' + shellKind + '\\nrg() { echo "RG-SHIM-CALLED $*"; }\\n');
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
    assert.match(p, /bundle-9\.9\.9-bash\.sh$/);
    assert.equal(bundleShellKind(p), 'bash');
  });
});

test('happy path on a zsh host: bundle filename and shell-kind marker record zsh', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9', FAKE_CLAUDE_SHELL_KIND: 'zsh',
  }, async () => {
    _resetForTest();
    const p = await getShellEnvBundlePath();
    const contents = await fsp.readFile(p, 'utf8');
    assert.match(contents, /CLAUDE_CODE_SHELL_KIND=zsh/);
    assert.match(p, /bundle-9\.9\.9-zsh\.sh$/);
    assert.equal(bundleShellKind(p), 'zsh');
  });
});

test('bundle generation uses the fast tier\'s bound Claude model, not a hardcoded Haiku default', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  const argvFile = path.join(home, 'argv.json');
  await withEnv({
    PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9',
    FAKE_CLAUDE_ARGV_FILE: argvFile,
  }, async () => {
    await setTierBackend('fast', { kind: 'claude', model: 'claude-opus-4-7' });
    _resetForTest();
    await getShellEnvBundlePath();
    const argv = JSON.parse(await fsp.readFile(argvFile, 'utf8'));
    const modelIdx = argv.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.equal(argv[modelIdx + 1], 'claude-opus-4-7');
  });
});

test('bundle generation fails fast with a clear reachability error when the fast tier is Ollama-bound and Ollama is unreachable', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  const restoreUnreach = fakeOllamaUnreachable();
  try {
    await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
      await setTierBackend('fast', { kind: 'ollama', model: 'deepseek-v4-flash:cloud' });
      _resetForTest();
      await assert.rejects(() => getShellEnvBundlePath(), /not reachable/i);
    });
  } finally {
    restoreUnreach();
  }
});

test('bundle generation actually spawns `ollama launch claude ...` when the fast tier is Ollama-bound and reachable (OLLAMA_BIN test injection)', async () => {
  const home = await mkTmp();
  const claudeBin = await writeFakeClaude(home); // used only for the claude --version cache-key probe
  const ollamaScript = path.join(home, 'fake-ollama.mjs');
  await fsp.writeFile(ollamaScript, FAKE_CLAUDE_SCRIPT, 'utf8'); // same behavior — argv/stdin driven, name-agnostic
  const ollamaBin = `${process.execPath} ${ollamaScript}`;
  const argvFile = path.join(home, 'argv.json');
  const restoreReach = fakeOllamaReachable();
  try {
    await withEnv({
      PROJECTS_ROOT: home, CLAUDE_BIN: claudeBin, OLLAMA_BIN: ollamaBin,
      FAKE_CLAUDE_MODE: 'happy', FAKE_CLAUDE_VERSION: '9.9.9',
      FAKE_CLAUDE_ARGV_FILE: argvFile,
    }, async () => {
      await setTierBackend('fast', { kind: 'ollama', model: 'deepseek-v4-flash:cloud' });
      _resetForTest();
      const p = await getShellEnvBundlePath();
      const contents = await fsp.readFile(p, 'utf8');
      assert.match(contents, /CLAUDE_CODE_EXECPATH/);

      const argv = JSON.parse(await fsp.readFile(argvFile, 'utf8'));
      assert.deepEqual(argv.slice(0, 6), ['launch', 'claude', '--model', 'deepseek-v4-flash:cloud', '--yes', '--']);
      assert.equal(argv[6], '-p');
      const modelIdxs = argv.map((a, i) => a === '--model' ? i : -1).filter(i => i >= 0);
      assert.equal(modelIdxs.length, 2, '--model appears in both the launch prefix and the forwarded claude args');
      for (const i of modelIdxs) assert.equal(argv[i + 1], 'deepseek-v4-flash:cloud');
    });
  } finally {
    restoreReach();
  }
});

test('bundleShellKind parses the shell suffix from a bundle path, defaulting unrecognized/legacy names to bash', () => {
  assert.equal(bundleShellKind('/x/bundle-9.9.9-zsh.sh'), 'zsh');
  assert.equal(bundleShellKind('/x/bundle-9.9.9-bash.sh'), 'bash');
  assert.equal(bundleShellKind('/x/bundle-9.9.9.sh'), 'bash');
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

// No bundle-9.9.9-*.sh (any shell suffix) should exist after a failed
// generation — covers both the old flat unsuffixed name (never produced by
// current code, so trivially absent) and the new per-shell names.
async function assertNoBundleFileFor(version) {
  const dir = path.join(orchStoreRoot(), 'shell-env');
  await assert.rejects(() => fsp.stat(path.join(dir, `bundle-${version}.sh`)));
  await assert.rejects(() => fsp.stat(path.join(dir, `bundle-${version}-bash.sh`)));
  await assert.rejects(() => fsp.stat(path.join(dir, `bundle-${version}-zsh.sh`)));
}

test('empty generated output fails validation and leaves no cache file', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'empty', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /empty|validation/i);
    await assertNoBundleFileFor('9.9.9');
  });
});

test('missing CLAUDE_CODE_EXECPATH marker fails validation and leaves no cache file', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'nomarker', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /CLAUDE_CODE_EXECPATH|validation/i);
    await assertNoBundleFileFor('9.9.9');
  });
});

test('missing CLAUDE_CODE_SHELL_KIND marker fails validation and leaves no cache file', async () => {
  const home = await mkTmp();
  const bin = await writeFakeClaude(home);
  await withEnv({ PROJECTS_ROOT: home, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: 'noshellkind', FAKE_CLAUDE_VERSION: '9.9.9' }, async () => {
    _resetForTest();
    await assert.rejects(() => getShellEnvBundlePath(), /CLAUDE_CODE_SHELL_KIND|validation/i);
    await assertNoBundleFileFor('9.9.9');
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
    const shell = bundleShellKind(bundlePath);
    const [bin, args] = shell === 'zsh' ? ['zsh', ['--no-rcs']] : ['bash', ['--noprofile', '--norc']];
    const script = `unset CLAUDE_CODE_EXECPATH; source ${bundlePath}; type rg; type find`;
    const { stdout } = await execFileP(bin, [...args, '-c', script]);
    assert.match(stdout, /rg is a (shell )?function/);
    assert.match(stdout, /find is a (shell )?function/);
  });
});

// Gated behind RUN_REAL_OLLAMA=1 — spawns the actually-installed `ollama`
// binary through the exact resolveBackendLaunch() shape production code
// uses, and asserts it forwards claude's --version stdout/exit-code
// verbatim (no extra banner/log chatter mixed into stdout). This matters
// because summarize.js's generateSummary() JSON.parses the FULL stdout of
// an ollama-launched claude call — any stdout chatter a future ollama
// release adds to its wrapper (not just stderr) would silently break that
// parse. This is the one test validating that assumption against real
// ollama/claude behavior; everything else in this file is fake-binary-driven.
// Override the model tag via REAL_OLLAMA_MODEL if the default isn't
// pulled/available on the test host.
const OLLAMA_ENABLED = !!process.env.RUN_REAL_OLLAMA;
const ot = OLLAMA_ENABLED ? test : test.skip.bind(test);

ot('real ollama: `ollama launch claude ... --version` forwards claude\'s stdout/exit-code verbatim', async () => {
  const tag = process.env.REAL_OLLAMA_MODEL || 'deepseek-v4-flash:cloud';
  const direct = await execFileP('claude', ['--version']);
  const { command, prefixArgs } = resolveBackendLaunch('ollama', tag, { command: 'claude', prefixArgs: [] });
  const viaOllama = await execFileP(command, [...prefixArgs, '--version']);
  assert.equal(viaOllama.stdout, direct.stdout, 'ollama-launched claude --version must forward stdout verbatim, with no wrapper chatter');
  assert.equal(viaOllama.stderr, direct.stderr);
});
