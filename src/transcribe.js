// Whisper.cpp transcription for the composer mic button. Receives raw
// browser-recorded audio (typically audio/webm;codecs=opus), converts to
// 16 kHz mono PCM WAV via ffmpeg, runs the whisper-cli binary against a
// quantized model, and returns the recognised text.
//
// Feature is gated on the presence of both WHISPER_CLI and WHISPER_MODEL
// (env vars override the defaults under <orchStoreRoot>/whisper.cpp/).
// If either file is missing, /api/transcribe/status reports unavailable
// and the frontend hides the mic button.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getTranscribeModel } from './appSettings.js';
import { modelFileName, DEFAULT_MODEL } from './whisperModels.js';
import { orchStoreRoot } from './projects.js';

// Root of the whisper.cpp install. Defaults to the orchestrator store
// (<projectsRoot>/.code-conductor/whisper.cpp), the same dir the rest of the
// app's state lives under. INSTALL_ROOT overrides it and mirrors the knob
// honoured by bin/install-whisper.sh, so the server and the installer agree
// on where the binary + models live (and tests can point both at a temp dir).
export function whisperRoot() {
  return path.join(process.env.INSTALL_ROOT || orchStoreRoot(), 'whisper.cpp');
}

export function modelsDir() {
  return path.join(whisperRoot(), 'models');
}

export function modelPathForName(name) {
  return path.join(modelsDir(), modelFileName(name));
}

function defaultPaths() {
  return {
    cli: path.join(whisperRoot(), 'build', 'bin', 'whisper-cli'),
    model: modelPathForName(DEFAULT_MODEL),
    ffmpeg: 'ffmpeg',
  };
}

// Resolve the active model path. Priority: WHISPER_MODEL env (an explicit
// absolute path) → the model chosen in Settings (persisted in settings.json)
// → the built-in default. The latter two derive a path under modelsDir().
function resolveModelPath() {
  if (process.env.WHISPER_MODEL) return process.env.WHISPER_MODEL;
  const chosen = getTranscribeModel();
  if (chosen) return modelPathForName(chosen);
  return modelPathForName(DEFAULT_MODEL);
}

export function whisperPaths() {
  const d = defaultPaths();
  return {
    cli: process.env.WHISPER_CLI || d.cli,
    model: resolveModelPath(),
    ffmpeg: process.env.FFMPEG_BIN || d.ffmpeg,
  };
}

// whisper-cli is run in-place from its CMake build tree, which bakes the
// *build-time* absolute paths of libwhisper/libggml into the binary's RUNPATH.
// When the install is relocated (e.g. migration 0004 moving it into the store)
// that RUNPATH points at a now-missing dir and the loader aborts with
// "CANNOT LINK EXECUTABLE … libwhisper.so.1 not found". Derive the lib dirs
// from the actual cli path (<root>/build/bin/whisper-cli → <root>/build/{src,
// ggml/src}) so they stay correct across relocations and honour a WHISPER_CLI
// override, and feed them via LD_LIBRARY_PATH at spawn time.
function whisperLibDirs(cli) {
  const buildDir = path.resolve(cli, '..', '..');
  return [path.join(buildDir, 'src'), path.join(buildDir, 'ggml', 'src')];
}

function whisperEnv(cli) {
  return {
    ...process.env,
    LD_LIBRARY_PATH: [...whisperLibDirs(cli), process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
}

export async function isAvailable() {
  const { cli, model } = whisperPaths();
  try {
    const [cliStat, modelStat] = await Promise.all([fs.stat(cli), fs.stat(model)]);
    return cliStat.isFile() && modelStat.isFile();
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function transcribe(audioBuf) {
  if (!Buffer.isBuffer(audioBuf) || audioBuf.length === 0) {
    const e = new Error('empty audio body');
    e.statusCode = 400;
    throw e;
  }
  const { cli, model, ffmpeg } = whisperPaths();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cc-transcribe-${randomUUID()}-`));
  const inputPath = path.join(dir, 'input.bin');
  const wavPath = path.join(dir, 'audio.wav');
  const outPrefix = path.join(dir, 'out');
  try {
    await fs.writeFile(inputPath, audioBuf);
    // Convert to 16 kHz mono 16-bit PCM WAV — whisper.cpp's required input.
    await run(ffmpeg, ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath]);
    // -of writes "<prefix>.txt"; --no-prints silences whisper-cli's progress noise.
    // env carries LD_LIBRARY_PATH so the loader finds libwhisper/libggml at the
    // current install path regardless of the binary's baked-in RUNPATH.
    await run(cli, ['-m', model, '-f', wavPath, '--output-txt', '-of', outPrefix, '--no-prints'],
      { env: whisperEnv(cli) });
    const text = await fs.readFile(`${outPrefix}.txt`, 'utf8');
    return text.trim();
  } finally {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
