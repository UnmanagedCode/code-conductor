import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor } from './helpers.mjs';
import { whisperPaths, modelPathForName } from '../src/transcribe.js';
import { setTranscribeModel } from '../src/appSettings.js';
import * as whisperInstall from '../src/whisperInstall.js';

// A bash stand-in for bin/install-whisper.sh: emits a couple of progress
// lines and `touch`es the whisper-cli binary + the requested model under
// INSTALL_ROOT, exactly where transcribe.js expects them. FAKE_INSTALL_SLEEP
// lets a test keep an install "running" long enough to probe concurrency.
const FAKE_INSTALL = `#!/usr/bin/env bash
echo "==> fake install for $WHISPER_MODEL_NAME"
mkdir -p "$INSTALL_ROOT/whisper.cpp/build/bin" "$INSTALL_ROOT/whisper.cpp/models"
if [ -n "\${FAKE_INSTALL_SLEEP:-}" ]; then sleep "$FAKE_INSTALL_SLEEP"; fi
: > "$INSTALL_ROOT/whisper.cpp/build/bin/whisper-cli"
chmod +x "$INSTALL_ROOT/whisper.cpp/build/bin/whisper-cli"
: > "$INSTALL_ROOT/whisper.cpp/models/ggml-\${WHISPER_MODEL_NAME}.bin"
echo "==> fake install done"
`;

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-settings-test-'));
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Clear the env knobs that would otherwise override INSTALL_ROOT-based paths.
const CLEAR_OVERRIDES = { WHISPER_CLI: undefined, WHISPER_MODEL: undefined, FFMPEG_BIN: undefined };

async function touchModel(installRoot, name) {
  const p = path.join(installRoot, 'whisper.cpp', 'models', `ggml-${name}.bin`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, 'fake-model');
}
async function touchCli(installRoot) {
  const p = path.join(installRoot, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 });
}

test('GET /api/settings/transcribe lists the catalog with per-model install state', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES }, async () => {
      await touchCli(installRoot);
      await touchModel(installRoot, 'small.en-q5_1'); // the default
      const { baseUrl, close } = await bootServer();
      try {
        const r = await api(baseUrl, 'GET', '/api/settings/transcribe');
        assert.equal(r.status, 200);
        assert.equal(r.body.available, true);
        assert.equal(r.body.activeModel, 'small.en-q5_1');
        const byName = Object.fromEntries(r.body.models.map(m => [m.name, m]));
        assert.equal(byName['small.en-q5_1'].installed, true);
        assert.equal(byName['base.en-q5_1'].installed, false);
        assert.ok(r.body.models.length >= 5, 'curated list present');
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/settings/transcribe/model switches to an installed model', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES }, async () => {
      await touchCli(installRoot);
      await touchModel(installRoot, 'small.en-q5_1');
      await touchModel(installRoot, 'base.en-q5_1');
      const { baseUrl, close } = await bootServer();
      try {
        const r = await api(baseUrl, 'POST', '/api/settings/transcribe/model', { model: 'base.en-q5_1' });
        assert.equal(r.status, 200);
        assert.equal(r.body.activeModel, 'base.en-q5_1');
        // And it persists into a fresh GET.
        const g = await api(baseUrl, 'GET', '/api/settings/transcribe');
        assert.equal(g.body.activeModel, 'base.en-q5_1');
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/settings/transcribe/model rejects unknown + not-installed models', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES }, async () => {
      await touchCli(installRoot);
      const { baseUrl, close } = await bootServer();
      try {
        const unknown = await api(baseUrl, 'POST', '/api/settings/transcribe/model', { model: 'totally-made-up' });
        assert.equal(unknown.status, 400);
        // Known model but the file isn't on disk → 400.
        const missing = await api(baseUrl, 'POST', '/api/settings/transcribe/model', { model: 'medium.en-q5_0' });
        assert.equal(missing.status, 400);
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('install flow: POST install → poll → model becomes available + active', async () => {
  whisperInstall._reset();
  const installRoot = await mkTmp();
  const scriptDir = await mkTmp();
  const script = path.join(scriptDir, 'fake-install.sh');
  await fs.writeFile(script, FAKE_INSTALL, { mode: 0o755 });
  try {
    await withEnv({
      INSTALL_ROOT: installRoot, WHISPER_INSTALL_SCRIPT: script, ...CLEAR_OVERRIDES,
    }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const start = await api(baseUrl, 'POST', '/api/settings/transcribe/install', { model: 'base.en-q5_1' });
        assert.equal(start.status, 200);
        assert.equal(start.body.started, true);

        await waitFor(async () => {
          const s = await api(baseUrl, 'GET', '/api/settings/transcribe/install/status');
          return s.body.running === false;
        }, { timeout: 15000, interval: 100 });

        const done = await api(baseUrl, 'GET', '/api/settings/transcribe/install/status');
        assert.equal(done.body.exitCode, 0);
        assert.match(done.body.log, /fake install done/);

        const state = await api(baseUrl, 'GET', '/api/settings/transcribe');
        assert.equal(state.body.available, true);
        assert.equal(state.body.activeModel, 'base.en-q5_1');
        assert.equal(state.body.models.find(m => m.name === 'base.en-q5_1').installed, true);
      } finally { await close(); }
    });
  } finally {
    whisperInstall._reset();
    await fs.rm(installRoot, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

test('install flow: a second install while one is running returns 409', async () => {
  whisperInstall._reset();
  const installRoot = await mkTmp();
  const scriptDir = await mkTmp();
  const script = path.join(scriptDir, 'fake-install.sh');
  await fs.writeFile(script, FAKE_INSTALL, { mode: 0o755 });
  try {
    await withEnv({
      INSTALL_ROOT: installRoot, WHISPER_INSTALL_SCRIPT: script,
      FAKE_INSTALL_SLEEP: '1', ...CLEAR_OVERRIDES,
    }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const first = await api(baseUrl, 'POST', '/api/settings/transcribe/install', { model: 'base.en-q5_1' });
        assert.equal(first.status, 200);
        const second = await api(baseUrl, 'POST', '/api/settings/transcribe/install', { model: 'tiny.en-q5_1' });
        assert.equal(second.status, 409);
        assert.equal(second.body.running, true);

        await waitFor(async () => {
          const s = await api(baseUrl, 'GET', '/api/settings/transcribe/install/status');
          return s.body.running === false;
        }, { timeout: 15000, interval: 100 });
      } finally { await close(); }
    });
  } finally {
    whisperInstall._reset();
    await fs.rm(installRoot, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

test('install start rejects an unknown model with 400', async () => {
  whisperInstall._reset();
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'POST', '/api/settings/transcribe/install', { model: 'nope' });
    assert.equal(r.status, 400);
  } finally { await close(); whisperInstall._reset(); }
});

test('whisperPaths resolves model: env > configured > default', async () => {
  // 1. WHISPER_MODEL env wins outright.
  await withEnv({ WHISPER_MODEL: '/explicit/path/model.bin', INSTALL_ROOT: '/tmp/x' }, async () => {
    assert.equal(whisperPaths().model, '/explicit/path/model.bin');
  });

  // 2. No env, a configured model → derived path under INSTALL_ROOT.
  const root = await mkTmp();      // PROJECTS_ROOT — where settings.json lives
  const installRoot = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES }, async () => {
      await setTranscribeModel('base.en-q5_1');
      assert.equal(whisperPaths().model, modelPathForName('base.en-q5_1'));
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(installRoot, { recursive: true, force: true });
  }

  // 3. No env, no config → built-in default.
  const root2 = await mkTmp();
  const installRoot2 = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root2, INSTALL_ROOT: installRoot2, ...CLEAR_OVERRIDES }, async () => {
      assert.equal(whisperPaths().model, modelPathForName('small.en-q5_1'));
    });
  } finally {
    await fs.rm(root2, { recursive: true, force: true });
    await fs.rm(installRoot2, { recursive: true, force: true });
  }
});
