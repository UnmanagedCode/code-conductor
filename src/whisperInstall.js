// Drives bin/install-whisper.sh from the web UI (Settings → Transcribe).
// One install runs at a time, process-wide; stdout+stderr are captured into a
// bounded in-memory ring so the frontend can poll progress. On a clean exit
// the freshly-installed model is persisted as the active transcribe model.
//
// The script path is overridable via WHISPER_INSTALL_SCRIPT (test injection,
// mirroring the CLAUDE_BIN fake-binary convention). The selected model name
// is gated by the caller against the whisperModels allow-list before it ever
// reaches the shell.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKnownModel } from './whisperModels.js';
import { setTranscribeModel } from './appSettings.js';
import { orchStoreRoot } from './projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(__dirname, '..', 'bin', 'install-whisper.sh');
const LOG_CAP = 64 * 1024; // bytes of tail kept in memory

let current = null; // { model, child, log, running, exitCode }

function scriptPath() {
  return process.env.WHISPER_INSTALL_SCRIPT || DEFAULT_SCRIPT;
}

function appendLog(state, chunk) {
  state.log += chunk;
  if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
}

export function isRunning() {
  return !!(current && current.running);
}

// Start an install. Returns { started:true } or { started:false, running:true }
// if one is already in flight. Throws (statusCode 400) on an unknown model.
export function start(model) {
  if (!isKnownModel(model)) {
    throw Object.assign(new Error(`unknown whisper model: ${model}`), { statusCode: 400 });
  }
  if (isRunning()) return { started: false, running: true };

  const state = { model, child: null, log: '', running: true, exitCode: null };
  const child = spawn('bash', [scriptPath()], {
    // Pin INSTALL_ROOT to the orchestrator store so the script installs where
    // transcribe.js looks for the binary + model, regardless of the script's
    // own fallback default.
    env: { ...process.env, WHISPER_MODEL_NAME: model, INSTALL_ROOT: process.env.INSTALL_ROOT || orchStoreRoot() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  appendLog(state, `==> Installing whisper.cpp + model "${model}"\n`);
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
        await setTranscribeModel(model);
        appendLog(state, `\n==> Done. Active model set to "${model}".\n`);
      } catch (e) {
        appendLog(state, `\nWARN: install succeeded but failed to persist active model: ${e.message}\n`);
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
  if (!current) return { running: false, model: null, exitCode: null, log: '' };
  return {
    running: current.running,
    model: current.model,
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
