import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { waitFor } from './helpers.mjs';
import { orchStoreRoot } from '../src/projects.js';
import { whisperRoot } from '../src/transcribe.js';
import { piperRoot } from '../src/tts.js';
import * as whisperInstall from '../src/whisperInstall.js';
import * as ttsInstall from '../src/ttsInstall.js';

// These tests pin down the install-location change: the AV assets default to
// the orchestrator store (<projectsRoot>/.code-conductor), NOT $HOME/.code-conductor,
// and the install drivers pin INSTALL_ROOT so the script can't drift from the server.

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-install-root-test-'));
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

test('whisperRoot/piperRoot default to the orchestrator store, honouring PROJECTS_ROOT', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, INSTALL_ROOT: undefined }, async () => {
      const expectedStore = path.join(root, '.code-conductor');
      assert.equal(orchStoreRoot(), expectedStore);
      assert.equal(whisperRoot(), path.join(expectedStore, 'whisper.cpp'));
      assert.equal(piperRoot(), path.join(expectedStore, 'piper'));
      // Crucially: NOT under $HOME/.code-conductor anymore.
      const home = process.env.HOME || os.homedir();
      assert.notEqual(whisperRoot(), path.join(home, '.code-conductor', 'whisper.cpp'));
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('INSTALL_ROOT still overrides the default for both features', async () => {
  const root = await mkTmp();
  const installRoot = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, INSTALL_ROOT: installRoot }, async () => {
      assert.equal(whisperRoot(), path.join(installRoot, 'whisper.cpp'));
      assert.equal(piperRoot(), path.join(installRoot, 'piper'));
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(installRoot, { recursive: true, force: true });
  }
});

// A fake installer that just reports the INSTALL_ROOT it was handed.
const REPORT_ROOT = `#!/usr/bin/env bash
echo "RESOLVED_INSTALL_ROOT=$INSTALL_ROOT"
`;

test('whisper install driver pins INSTALL_ROOT to the orchestrator store when unset', async () => {
  whisperInstall._reset();
  const root = await mkTmp();
  const scriptDir = await mkTmp();
  const script = path.join(scriptDir, 'report-root.sh');
  await fs.writeFile(script, REPORT_ROOT, { mode: 0o755 });
  try {
    await withEnv({ PROJECTS_ROOT: root, INSTALL_ROOT: undefined, WHISPER_INSTALL_SCRIPT: script }, async () => {
      whisperInstall.start('base.en-q5_1');
      await waitFor(() => whisperInstall.isRunning() === false, { timeout: 15000, interval: 50 });
      const expected = path.join(root, '.code-conductor');
      assert.match(whisperInstall.status().log, new RegExp(`RESOLVED_INSTALL_ROOT=${expected}\\b`));
    });
  } finally {
    whisperInstall._reset();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

test('tts install driver pins INSTALL_ROOT to the orchestrator store when unset', async () => {
  ttsInstall._reset();
  const root = await mkTmp();
  const scriptDir = await mkTmp();
  const script = path.join(scriptDir, 'report-root.sh');
  await fs.writeFile(script, REPORT_ROOT, { mode: 0o755 });
  try {
    await withEnv({ PROJECTS_ROOT: root, INSTALL_ROOT: undefined, PIPER_INSTALL_SCRIPT: script }, async () => {
      ttsInstall.start('en_US-lessac-medium');
      await waitFor(() => ttsInstall.isRunning() === false, { timeout: 15000, interval: 50 });
      const expected = path.join(root, '.code-conductor');
      assert.match(ttsInstall.status().log, new RegExp(`RESOLVED_INSTALL_ROOT=${expected}\\b`));
    });
  } finally {
    ttsInstall._reset();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});
