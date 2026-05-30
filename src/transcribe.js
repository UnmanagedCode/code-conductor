// Whisper.cpp transcription for the composer mic button. Receives raw
// browser-recorded audio (typically audio/webm;codecs=opus), converts to
// 16 kHz mono PCM WAV via ffmpeg, runs the whisper-cli binary against a
// quantized model, and returns the recognised text.
//
// Feature is gated on the presence of both WHISPER_CLI and WHISPER_MODEL
// (env vars override the defaults under ~/.code-conductor/whisper.cpp/).
// If either file is missing, /api/transcribe/status reports unavailable
// and the frontend hides the mic button.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function defaultPaths() {
  const home = process.env.HOME || os.homedir();
  return {
    cli: path.join(home, '.code-conductor', 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
    model: path.join(home, '.code-conductor', 'whisper.cpp', 'models', 'ggml-base.en-q5_1.bin'),
    ffmpeg: 'ffmpeg',
  };
}

export function whisperPaths() {
  const d = defaultPaths();
  return {
    cli: process.env.WHISPER_CLI || d.cli,
    model: process.env.WHISPER_MODEL || d.model,
    ffmpeg: process.env.FFMPEG_BIN || d.ffmpeg,
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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    await run(cli, ['-m', model, '-f', wavPath, '--output-txt', '-of', outPrefix, '--no-prints']);
    const text = await fs.readFile(`${outPrefix}.txt`, 'utf8');
    return text.trim();
  } finally {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
