// Shared factory behind whisperInstall.js (Settings → Transcribe) and
// ttsInstall.js (Settings → TTS). Both drive a bin/install-*.sh script from the
// web UI as a single process-wide singleton: one install runs at a time,
// stdout+stderr are captured into a bounded in-memory ring so the frontend can
// poll progress, and on a clean exit (code 0) the freshly-installed item is
// persisted as the active model/voice.
//
// makeInstallRunner returns the exact public surface both modules expose
// today — { start, status, isRunning, _reset } — so callers and tests are
// unchanged. The per-feature differences are injected as config.

import { spawn } from 'node:child_process';
import { orchStoreRoot } from './projects.js';

const LOG_CAP = 64 * 1024; // bytes of tail kept in memory

// config:
//   scriptDefault  default bin/install-*.sh path (resolved by the caller from
//                  its own import.meta.url, not here)
//   scriptEnvVar   env var that overrides the script path (read lazily at start
//                  time so test injection works), e.g. WHISPER_INSTALL_SCRIPT
//   childEnvVar    env var the script reads the item name from, e.g.
//                  WHISPER_MODEL_NAME / PIPER_VOICE_NAME
//   validate       allow-list predicate (isKnownModel / isKnownVoice)
//   persist        async setter run on clean exit (setTranscribeModel/setTtsVoice)
//   itemKey        'model' | 'voice' — names the state/status field + log noun
//   unknownNoun    noun used in the unknown-item throw ('whisper model' / 'piper voice')
//   startLabel     banner subject ('whisper.cpp + model' / 'Piper + voice')
export function makeInstallRunner(config) {
  const { scriptDefault, scriptEnvVar, childEnvVar, validate, persist,
          itemKey, unknownNoun, startLabel } = config;

  let current = null; // { [itemKey], child, log, running, exitCode }

  function scriptPath() {
    return process.env[scriptEnvVar] || scriptDefault;
  }

  function appendLog(state, chunk) {
    state.log += chunk;
    if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
  }

  function isRunning() {
    return !!(current && current.running);
  }

  // Start an install. Returns { started:true } or { started:false, running:true }
  // if one is already in flight. Throws (statusCode 400) on an unknown item.
  function start(name) {
    if (!validate(name)) {
      throw Object.assign(new Error(`unknown ${unknownNoun}: ${name}`), { statusCode: 400 });
    }
    if (isRunning()) return { started: false, running: true };

    const state = { [itemKey]: name, child: null, log: '', running: true, exitCode: null };
    const child = spawn('bash', [scriptPath()], {
      // Pin INSTALL_ROOT to the orchestrator store so the script installs where
      // the server looks for the binary/venv + assets, regardless of the
      // script's own fallback default.
      env: { ...process.env, [childEnvVar]: name, INSTALL_ROOT: process.env.INSTALL_ROOT || orchStoreRoot() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;
    appendLog(state, `==> Installing ${startLabel} "${name}"\n`);
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
          await persist(name);
          appendLog(state, `\n==> Done. Active ${itemKey} set to "${name}".\n`);
        } catch (e) {
          appendLog(state, `\nWARN: install succeeded but failed to persist active ${itemKey}: ${e.message}\n`);
        }
      } else {
        appendLog(state, `\nERROR: installer exited with code ${code}.\n`);
      }
      state.running = false;
    });

    current = state;
    return { started: true, running: true };
  }

  function status() {
    if (!current) return { running: false, [itemKey]: null, exitCode: null, log: '' };
    return {
      running: current.running,
      [itemKey]: current[itemKey],
      exitCode: current.exitCode,
      log: current.log,
    };
  }

  // Test-only: drop the in-memory install state.
  function _reset() {
    if (current?.child && current.running) {
      try { current.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    current = null;
  }

  return { start, status, isRunning, _reset };
}
