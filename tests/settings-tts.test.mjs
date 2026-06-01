import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor } from './helpers.mjs';
import {
  setTranscribeModel, getTranscribeModel,
  setTtsVoice, getTtsVoice, getTtsEnabled, getTtsRate,
} from '../src/appSettings.js';
import * as ttsInstall from '../src/ttsInstall.js';

// A bash stand-in for bin/install-piper.sh: touches the venv python3 + the
// requested voice's .onnx/.onnx.json under INSTALL_ROOT, exactly where tts.js
// expects them. FAKE_INSTALL_SLEEP keeps an install "running" for concurrency.
const FAKE_INSTALL = `#!/usr/bin/env bash
echo "==> fake piper install for $PIPER_VOICE_NAME"
mkdir -p "$INSTALL_ROOT/piper/venv/bin" "$INSTALL_ROOT/piper/voices"
if [ -n "\${FAKE_INSTALL_SLEEP:-}" ]; then sleep "$FAKE_INSTALL_SLEEP"; fi
: > "$INSTALL_ROOT/piper/venv/bin/python3"
chmod +x "$INSTALL_ROOT/piper/venv/bin/python3"
: > "$INSTALL_ROOT/piper/voices/\${PIPER_VOICE_NAME}.onnx"
echo '{}' > "$INSTALL_ROOT/piper/voices/\${PIPER_VOICE_NAME}.onnx.json"
echo "==> fake piper install done"
`;

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-settings-tts-'));
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

// Clear env knobs that would override INSTALL_ROOT-based paths.
const CLEAR = { PIPER_VOICE: undefined, PIPER_VENV: undefined, PIPER_PYTHON: undefined };

async function touchPython(installRoot) {
  const p = path.join(installRoot, 'piper', 'venv', 'bin', 'python3');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 });
}
async function touchVoice(installRoot, name) {
  const dir = path.join(installRoot, 'piper', 'voices');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.onnx`), 'fake');
  await fs.writeFile(path.join(dir, `${name}.onnx.json`), '{}');
}

test('GET /api/settings/tts lists the catalog with per-voice install state + prefs', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR }, async () => {
      await touchPython(installRoot);
      await touchVoice(installRoot, 'en_US-lessac-medium'); // the default
      const { baseUrl, close } = await bootServer();
      try {
        const r = await api(baseUrl, 'GET', '/api/settings/tts');
        assert.equal(r.status, 200);
        assert.equal(r.body.available, true);
        assert.equal(r.body.activeVoice, 'en_US-lessac-medium');
        assert.equal(r.body.enabled, false);
        assert.equal(r.body.rate, 1.0);
        const byName = Object.fromEntries(r.body.voices.map(v => [v.name, v]));
        assert.equal(byName['en_US-lessac-medium'].installed, true);
        assert.equal(byName['en_US-amy-medium'].installed, false);
        assert.ok(r.body.voices.length >= 3, 'curated list present');
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/settings/tts/voice switches to an installed voice', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR }, async () => {
      await touchPython(installRoot);
      await touchVoice(installRoot, 'en_US-lessac-medium');
      await touchVoice(installRoot, 'en_US-amy-medium');
      const { baseUrl, close } = await bootServer();
      try {
        const r = await api(baseUrl, 'POST', '/api/settings/tts/voice', { voice: 'en_US-amy-medium' });
        assert.equal(r.status, 200);
        assert.equal(r.body.activeVoice, 'en_US-amy-medium');
        const g = await api(baseUrl, 'GET', '/api/settings/tts');
        assert.equal(g.body.activeVoice, 'en_US-amy-medium');
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/settings/tts/voice rejects unknown + not-installed voices', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR }, async () => {
      await touchPython(installRoot);
      const { baseUrl, close } = await bootServer();
      try {
        const unknown = await api(baseUrl, 'POST', '/api/settings/tts/voice', { voice: 'totally-made-up' });
        assert.equal(unknown.status, 400);
        const missing = await api(baseUrl, 'POST', '/api/settings/tts/voice', { voice: 'en_US-ryan-high' });
        assert.equal(missing.status, 400);
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/settings/tts/prefs persists enabled + rate', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR }, async () => {
      await touchPython(installRoot);
      await touchVoice(installRoot, 'en_US-lessac-medium');
      const { baseUrl, close } = await bootServer();
      try {
        const r = await api(baseUrl, 'POST', '/api/settings/tts/prefs', { enabled: true, rate: 1.5 });
        assert.equal(r.status, 200);
        assert.equal(r.body.enabled, true);
        assert.equal(r.body.rate, 1.5);
        const g = await api(baseUrl, 'GET', '/api/settings/tts');
        assert.equal(g.body.enabled, true);
        assert.equal(g.body.rate, 1.5);
        // Out-of-range rate is clamped (0.5–2.0).
        const c = await api(baseUrl, 'POST', '/api/settings/tts/prefs', { rate: 9 });
        assert.equal(c.body.rate, 2.0);
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

const RUN_INSTALL = process.env.RUN_TTS_INSTALL_TESTS ? undefined : 'set RUN_TTS_INSTALL_TESTS=1 to run';

test('install flow: POST install → poll → voice becomes available + active', { skip: RUN_INSTALL }, async () => {
  ttsInstall._reset();
  const installRoot = await mkTmp();
  const scriptDir = await mkTmp();
  const script = path.join(scriptDir, 'fake-install.sh');
  await fs.writeFile(script, FAKE_INSTALL, { mode: 0o755 });
  try {
    await withEnv({ INSTALL_ROOT: installRoot, PIPER_INSTALL_SCRIPT: script, ...CLEAR }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const start = await api(baseUrl, 'POST', '/api/settings/tts/install', { voice: 'en_US-amy-medium' });
        assert.equal(start.status, 200);
        assert.equal(start.body.started, true);

        await waitFor(async () => {
          const s = await api(baseUrl, 'GET', '/api/settings/tts/install/status');
          return s.body.running === false;
        }, { timeout: 15000, interval: 100 });

        const done = await api(baseUrl, 'GET', '/api/settings/tts/install/status');
        assert.equal(done.body.exitCode, 0);
        assert.match(done.body.log, /fake piper install done/);

        const state = await api(baseUrl, 'GET', '/api/settings/tts');
        assert.equal(state.body.available, true);
        assert.equal(state.body.activeVoice, 'en_US-amy-medium');
        assert.equal(state.body.voices.find(v => v.name === 'en_US-amy-medium').installed, true);
      } finally { await close(); }
    });
  } finally {
    ttsInstall._reset();
    await fs.rm(installRoot, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

test('install flow: a second install while one is running returns 409', { skip: RUN_INSTALL }, async () => {
  ttsInstall._reset();
  const installRoot = await mkTmp();
  const scriptDir = await mkTmp();
  const script = path.join(scriptDir, 'fake-install.sh');
  await fs.writeFile(script, FAKE_INSTALL, { mode: 0o755 });
  try {
    await withEnv({
      INSTALL_ROOT: installRoot, PIPER_INSTALL_SCRIPT: script,
      FAKE_INSTALL_SLEEP: '1', ...CLEAR,
    }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const first = await api(baseUrl, 'POST', '/api/settings/tts/install', { voice: 'en_US-amy-medium' });
        assert.equal(first.status, 200);
        const second = await api(baseUrl, 'POST', '/api/settings/tts/install', { voice: 'en_GB-alba-medium' });
        assert.equal(second.status, 409);
        assert.equal(second.body.running, true);

        await waitFor(async () => {
          const s = await api(baseUrl, 'GET', '/api/settings/tts/install/status');
          return s.body.running === false;
        }, { timeout: 15000, interval: 100 });
      } finally { await close(); }
    });
  } finally {
    ttsInstall._reset();
    await fs.rm(installRoot, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

test('install start rejects an unknown voice with 400', async () => {
  ttsInstall._reset();
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'POST', '/api/settings/tts/install', { voice: 'nope' });
    assert.equal(r.status, 400);
  } finally { await close(); ttsInstall._reset(); }
});

test('appSettings tts get/set does not clobber transcribe/models', async () => {
  const root = await mkTmp(); // PROJECTS_ROOT — where settings.json lives
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTranscribeModel('base.en-q5_1');
      await setTtsVoice('en_US-amy-medium');
      // Both namespaces survive independent writes.
      assert.equal(getTranscribeModel(), 'base.en-q5_1');
      assert.equal(getTtsVoice(), 'en_US-amy-medium');
      // Defaults for the unset tts prefs.
      assert.equal(getTtsEnabled(), false);
      assert.equal(getTtsRate(), 1.0);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
