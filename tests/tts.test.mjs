import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer } from './helpers.mjs';
import { ttsPaths, voicePathForName } from '../src/tts.js';
import { setTtsVoice } from '../src/appSettings.js';
import { DEFAULT_VOICE } from '../src/ttsModels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SYNTH = path.join(__dirname, 'fake-piper-synth.mjs');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-tts-test-'));
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

// Env knobs that would otherwise override INSTALL_ROOT-based paths.
const CLEAR_OVERRIDES = { PIPER_VOICE: undefined, PIPER_VENV: undefined };

async function touchVoice(installRoot, name) {
  const dir = path.join(installRoot, 'piper', 'voices');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.onnx`), 'fake-onnx');
  await fs.writeFile(path.join(dir, `${name}.onnx.json`), '{"audio":{"sample_rate":22050}}');
}

// Make TTS "available": a real python (node) as PIPER_PYTHON, the fake synth
// script, and the default voice's files on disk.
function availableEnv(installRoot) {
  return {
    INSTALL_ROOT: installRoot,
    PIPER_PYTHON: process.execPath,
    PIPER_SYNTH_SCRIPT: FAKE_SYNTH,
    ...CLEAR_OVERRIDES,
  };
}

// Read a binary response and split it into [4-byte LE length][payload] frames.
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    if (off + len > buf.length) break;
    frames.push(buf.subarray(off, off + len));
    off += len;
  }
  return frames;
}

test('GET /api/tts/status reports available when python + voice present', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv(availableEnv(installRoot), async () => {
      await touchVoice(installRoot, DEFAULT_VOICE);
      const { baseUrl, close } = await bootServer();
      try {
        const r = await fetch(`${baseUrl}/api/tts/status`);
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { available: true });
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('GET /api/tts/status reports unavailable when nothing is installed', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES, PIPER_PYTHON: undefined, PIPER_SYNTH_SCRIPT: undefined }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const r = await fetch(`${baseUrl}/api/tts/status`);
        assert.equal((await r.json()).available, false);
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/tts streams framed WAV audio', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv(availableEnv(installRoot), async () => {
      await touchVoice(installRoot, DEFAULT_VOICE);
      const { baseUrl, close } = await bootServer();
      try {
        const r = await fetch(`${baseUrl}/api/tts`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'Hello there.',
        });
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') || '', /application\/octet-stream/);
        const buf = Buffer.from(await r.arrayBuffer());
        const frames = parseFrames(buf);
        assert.ok(frames.length >= 1, 'at least one sentence frame');
        assert.equal(frames[0].subarray(0, 4).toString('ascii'), 'RIFF');
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/tts returns 503 when piper is unavailable', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv({ INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES, PIPER_PYTHON: undefined, PIPER_SYNTH_SCRIPT: undefined }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const r = await fetch(`${baseUrl}/api/tts`, {
          method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi',
        });
        assert.equal(r.status, 503);
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('POST /api/tts returns 400 on empty body', async () => {
  const installRoot = await mkTmp();
  try {
    await withEnv(availableEnv(installRoot), async () => {
      await touchVoice(installRoot, DEFAULT_VOICE);
      const { baseUrl, close } = await bootServer();
      try {
        const r = await fetch(`${baseUrl}/api/tts`, {
          method: 'POST', headers: { 'content-type': 'text/plain' }, body: '   ',
        });
        assert.equal(r.status, 400);
      } finally { await close(); }
    });
  } finally { await fs.rm(installRoot, { recursive: true, force: true }); }
});

test('ttsPaths resolves voice: env > configured > default', async () => {
  // 1. PIPER_VOICE env wins outright.
  await withEnv({ PIPER_VOICE: '/explicit/voice.onnx', INSTALL_ROOT: '/tmp/x' }, async () => {
    assert.equal(ttsPaths().model, '/explicit/voice.onnx');
    assert.equal(ttsPaths().config, '/explicit/voice.onnx.json');
  });

  // 2. No env, a configured voice → derived path under INSTALL_ROOT.
  const root = await mkTmp();       // PROJECTS_ROOT — where settings.json lives
  const installRoot = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, INSTALL_ROOT: installRoot, ...CLEAR_OVERRIDES }, async () => {
      await setTtsVoice('en_US-amy-medium');
      assert.equal(ttsPaths().model, voicePathForName('en_US-amy-medium'));
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
      assert.equal(ttsPaths().model, voicePathForName(DEFAULT_VOICE));
    });
  } finally {
    await fs.rm(root2, { recursive: true, force: true });
    await fs.rm(installRoot2, { recursive: true, force: true });
  }
});
