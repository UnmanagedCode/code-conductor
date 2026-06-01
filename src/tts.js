// Piper text-to-speech for the conversation's "🔊 speak" affordance. The
// inverse of transcribe.js: takes assistant text and produces audio. Piper's
// PiperVoice.synthesize() yields one AudioChunk per sentence, so we synthesize
// *streaming* — a small Python helper (bin/piper-synth.py) loads the voice once
// and writes one self-contained WAV per sentence to stdout, length-prefixed,
// flushing as each sentence is ready (first sentence in ~0.3s). synthesize()
// returns that child process so the route can pipe stdout straight to the
// HTTP response without buffering the whole paragraph.
//
// Feature is gated on the presence of the piper venv python + the active
// voice's .onnx and .onnx.json (env vars override the defaults under
// ~/.code-conductor/piper/). If anything is missing, /api/tts/status reports
// unavailable and the frontend hides the speak button.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getTtsVoice, getTtsRate } from './appSettings.js';
import { voiceFileName, DEFAULT_VOICE } from './ttsModels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYNTH_SCRIPT = path.resolve(__dirname, '..', 'bin', 'piper-synth.py');

// Root of the piper install. INSTALL_ROOT mirrors the knob honoured by
// bin/install-piper.sh, so the server and the installer agree on where the
// venv + voices live (and tests can point both at a temp dir).
export function piperRoot() {
  const home = process.env.HOME || os.homedir();
  return path.join(process.env.INSTALL_ROOT || path.join(home, '.code-conductor'), 'piper');
}

export function voicesDir() {
  return path.join(piperRoot(), 'voices');
}

export function voicePathForName(name) {
  return path.join(voicesDir(), voiceFileName(name));
}

// venv python: PIPER_PYTHON (explicit) → PIPER_VENV/bin/python3 → <root>/venv.
function pythonPath() {
  if (process.env.PIPER_PYTHON) return process.env.PIPER_PYTHON;
  const venv = process.env.PIPER_VENV || path.join(piperRoot(), 'venv');
  return path.join(venv, 'bin', 'python3');
}

function synthScriptPath() {
  return process.env.PIPER_SYNTH_SCRIPT || DEFAULT_SYNTH_SCRIPT;
}

// Resolve the active voice's model path. Priority: PIPER_VOICE env (explicit
// absolute .onnx path) → the voice chosen in Settings (settings.json) → the
// built-in default. The latter two derive a path under voicesDir().
function resolveVoicePath() {
  if (process.env.PIPER_VOICE) return process.env.PIPER_VOICE;
  const chosen = getTtsVoice();
  if (chosen) return voicePathForName(chosen);
  return voicePathForName(DEFAULT_VOICE);
}

export function ttsPaths() {
  const model = resolveVoicePath();
  return {
    python: pythonPath(),
    model,
    config: `${model}.json`,
    synthScript: synthScriptPath(),
  };
}

export async function isAvailable() {
  const { python, model, config } = ttsPaths();
  try {
    const [py, m, c] = await Promise.all([fs.stat(python), fs.stat(model), fs.stat(config)]);
    return py.isFile() && m.isFile() && c.isFile();
  } catch {
    return false;
  }
}

// Spawn the streaming synthesizer for `text`. Returns the child process; the
// caller pipes child.stdout (a sequence of [4-byte LE length][WAV] frames, one
// per sentence) to the HTTP response and kills the child if the client aborts.
// rate maps to Piper's length_scale (inverse of speed): faster rate → shorter
// scale. Throws { statusCode: 400 } on empty text.
export function synthesize(text, { voice, rate } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    const e = new Error('empty text body');
    e.statusCode = 400;
    throw e;
  }
  const { python, synthScript } = ttsPaths();
  // An explicit voice arg overrides the configured/default one (e.g. a future
  // per-message voice). Falls back to the resolved active voice path.
  const model = voice ? voicePathForName(voice) : resolveVoicePath();
  const config = `${model}.json`;
  const r = rate ?? getTtsRate();
  const lengthScale = r && r > 0 ? 1 / r : 1;

  const args = [
    synthScript,
    '--model', model,
    '--config', config,
    '--length-scale', String(lengthScale),
  ];
  const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(text);
  child.stdin.end();
  return child;
}
