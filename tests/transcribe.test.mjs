import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api } from './helpers.mjs';

// Fake whisper-cli: parses `-of <prefix>` and writes "<prefix>.txt".
// CJS so the shebang-exec path works without an .mjs extension.
const FAKE_WHISPER = `
const fs = require('fs');
const args = process.argv.slice(2);
const ofIdx = args.indexOf('-of');
const out = ofIdx >= 0 ? args[ofIdx + 1] : 'out';
const text = process.env.FAKE_WHISPER_TEXT || 'hello from fake whisper';
fs.writeFileSync(out + '.txt', text + '\\n');
`;

// Fake whisper-cli that records the LD_LIBRARY_PATH it was spawned with into
// "<prefix>.txt" — lets a test assert the build-lib dirs were wired in.
const FAKE_WHISPER_ECHO_LDPATH = `
const fs = require('fs');
const args = process.argv.slice(2);
const ofIdx = args.indexOf('-of');
const out = ofIdx >= 0 ? args[ofIdx + 1] : 'out';
fs.writeFileSync(out + '.txt', (process.env.LD_LIBRARY_PATH || '') + '\\n');
`;

// Fake ffmpeg: parses `-i <input>` and copies it to the last positional arg.
const FAKE_FFMPEG = `
const fs = require('fs');
const args = process.argv.slice(2);
const iIdx = args.indexOf('-i');
const input = args[iIdx + 1];
const output = args[args.length - 1];
fs.writeFileSync(output, fs.readFileSync(input));
`;

async function writeFakeBin(dir, name, body) {
  const p = path.join(dir, name);
  await fs.writeFile(p, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return p;
}

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-transcribe-test-'));
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

async function setupFakes() {
  const tmp = await mkTmp();
  const cli = await writeFakeBin(tmp, 'fake-whisper', FAKE_WHISPER);
  const ffmpeg = await writeFakeBin(tmp, 'fake-ffmpeg', FAKE_FFMPEG);
  const model = path.join(tmp, 'model.bin');
  await fs.writeFile(model, 'fake-model-bytes');
  return { tmp, cli, ffmpeg, model };
}

test('GET /api/transcribe/status reports unavailable when binaries missing', async () => {
  await withEnv({
    WHISPER_CLI: '/nonexistent/whisper-cli-xyz',
    WHISPER_MODEL: '/nonexistent/model.bin',
    FFMPEG_BIN: '/nonexistent/ffmpeg',
  }, async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const r = await api(baseUrl, 'GET', '/api/transcribe/status');
      assert.equal(r.status, 200);
      assert.equal(r.body.available, false);
    } finally { await close(); }
  });
});

test('GET /api/transcribe/status reports available when fakes exist', async () => {
  const { tmp, cli, ffmpeg, model } = await setupFakes();
  try {
    await withEnv({ WHISPER_CLI: cli, WHISPER_MODEL: model, FFMPEG_BIN: ffmpeg }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const r = await api(baseUrl, 'GET', '/api/transcribe/status');
        assert.equal(r.status, 200);
        assert.equal(r.body.available, true);
      } finally { await close(); }
    });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('POST /api/transcribe returns the canned text from the fake whisper-cli', async () => {
  const { tmp, cli, ffmpeg, model } = await setupFakes();
  try {
    await withEnv({
      WHISPER_CLI: cli, WHISPER_MODEL: model, FFMPEG_BIN: ffmpeg,
      FAKE_WHISPER_TEXT: 'good morning',
    }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const res = await fetch(baseUrl + '/api/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'audio/webm' },
          body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.text, 'good morning');
      } finally { await close(); }
    });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('POST /api/transcribe spawns whisper-cli with the build lib dirs on LD_LIBRARY_PATH', async () => {
  const tmp = await mkTmp();
  try {
    // Lay the cli out at the real <root>/build/bin/whisper-cli shape so the
    // derived lib dirs are <root>/build/{src,ggml/src}.
    const binDir = path.join(tmp, 'whisper.cpp', 'build', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const cli = await writeFakeBin(binDir, 'whisper-cli', FAKE_WHISPER_ECHO_LDPATH);
    const ffmpeg = await writeFakeBin(tmp, 'fake-ffmpeg', FAKE_FFMPEG);
    const model = path.join(tmp, 'model.bin');
    await fs.writeFile(model, 'fake-model-bytes');
    await withEnv({ WHISPER_CLI: cli, WHISPER_MODEL: model, FFMPEG_BIN: ffmpeg }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const res = await fetch(baseUrl + '/api/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'audio/webm' },
          body: new Uint8Array([1, 2, 3, 4]),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        const buildDir = path.join(tmp, 'whisper.cpp', 'build');
        assert.ok(body.text.includes(path.join(buildDir, 'src')),
          `expected build/src in LD_LIBRARY_PATH, got: ${body.text}`);
        assert.ok(body.text.includes(path.join(buildDir, 'ggml', 'src')),
          `expected build/ggml/src in LD_LIBRARY_PATH, got: ${body.text}`);
      } finally { await close(); }
    });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('POST /api/transcribe with empty body returns 400', async () => {
  const { tmp, cli, ffmpeg, model } = await setupFakes();
  try {
    await withEnv({ WHISPER_CLI: cli, WHISPER_MODEL: model, FFMPEG_BIN: ffmpeg }, async () => {
      const { baseUrl, close } = await bootServer();
      try {
        const res = await fetch(baseUrl + '/api/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'audio/webm' },
          body: new Uint8Array(0),
        });
        assert.equal(res.status, 400);
      } finally { await close(); }
    });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('POST /api/transcribe returns 503 when whisper is not installed', async () => {
  await withEnv({
    WHISPER_CLI: '/nonexistent/whisper-cli',
    WHISPER_MODEL: '/nonexistent/model.bin',
    FFMPEG_BIN: '/nonexistent/ffmpeg',
  }, async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const res = await fetch(baseUrl + '/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: new Uint8Array([1, 2, 3]),
      });
      assert.equal(res.status, 503);
    } finally { await close(); }
  });
});
