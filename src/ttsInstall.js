// Drives bin/install-piper.sh from the web UI (Settings → TTS). One install
// runs at a time, process-wide; stdout+stderr are captured into a bounded
// in-memory ring so the frontend can poll progress. On a clean exit the
// freshly-installed voice is persisted as the active TTS voice.
//
// The script path is overridable via PIPER_INSTALL_SCRIPT (test injection,
// mirroring the CLAUDE_BIN fake-binary convention). The selected voice name is
// gated by the caller against the ttsModels allow-list before it ever reaches
// the shell.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKnownVoice } from './ttsModels.js';
import { setTtsVoice } from './appSettings.js';
import { orchStoreRoot } from './projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(__dirname, '..', 'bin', 'install-piper.sh');
const LOG_CAP = 64 * 1024; // bytes of tail kept in memory

let current = null; // { voice, child, log, running, exitCode }

function scriptPath() {
  return process.env.PIPER_INSTALL_SCRIPT || DEFAULT_SCRIPT;
}

function appendLog(state, chunk) {
  state.log += chunk;
  if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
}

export function isRunning() {
  return !!(current && current.running);
}

// Start an install. Returns { started:true } or { started:false, running:true }
// if one is already in flight. Throws (statusCode 400) on an unknown voice.
export function start(voice) {
  if (!isKnownVoice(voice)) {
    throw Object.assign(new Error(`unknown piper voice: ${voice}`), { statusCode: 400 });
  }
  if (isRunning()) return { started: false, running: true };

  const state = { voice, child: null, log: '', running: true, exitCode: null };
  const child = spawn('bash', [scriptPath()], {
    // Pin INSTALL_ROOT to the orchestrator store so the script installs where
    // tts.js looks for the venv + voices, regardless of the script's own
    // fallback default.
    env: { ...process.env, PIPER_VOICE_NAME: voice, INSTALL_ROOT: process.env.INSTALL_ROOT || orchStoreRoot() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  appendLog(state, `==> Installing Piper + voice "${voice}"\n`);
  child.stdout.on('data', (b) => appendLog(state, b.toString()));
  child.stderr.on('data', (b) => appendLog(state, b.toString()));
  child.on('error', (err) => {
    appendLog(state, `\nERROR: failed to launch installer: ${err.message}\n`);
    state.running = false;
    state.exitCode = -1;
  });
  child.on('close', async (code) => {
    state.exitCode = code;
    if (code === 0) {
      try {
        await setTtsVoice(voice);
        appendLog(state, `\n==> Done. Active voice set to "${voice}".\n`);
      } catch (e) {
        appendLog(state, `\nWARN: install succeeded but failed to persist active voice: ${e.message}\n`);
      }
    } else {
      appendLog(state, `\nERROR: installer exited with code ${code}.\n`);
    }
    state.running = false;
  });

  current = state;
  return { started: true, running: true };
}

export function status() {
  if (!current) return { running: false, voice: null, exitCode: null, log: '' };
  return {
    running: current.running,
    voice: current.voice,
    exitCode: current.exitCode,
    log: current.log,
  };
}

// Test-only: drop the in-memory install state.
export function _reset() {
  if (current?.child && current.running) {
    try { current.child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  current = null;
}
