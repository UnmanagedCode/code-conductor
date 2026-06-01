// Fake stand-in for bin/piper-synth.py, injected via PIPER_PYTHON=node +
// PIPER_SYNTH_SCRIPT=<this file>. Ignores its --model/--config/--length-scale
// args, reads text from stdin, and emits the real wire format the route +
// client expect: one [4-byte LE length][WAV] frame containing a tiny silent
// 16 kHz mono WAV. No real Piper (or even espeak) needed.

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) { process.exit(0); }

  const sampleRate = 22050;
  const numSamples = 256;           // ~12 ms of silence
  const dataBytes = numSamples * 2; // 16-bit mono
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);        // PCM fmt chunk size
  wav.writeUInt16LE(1, 20);         // PCM
  wav.writeUInt16LE(1, 22);         // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32);         // block align
  wav.writeUInt16LE(16, 34);        // bits per sample
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  // PCM body left as zeros (silence).

  const len = Buffer.alloc(4);
  len.writeUInt32LE(wav.length, 0);
  process.stdout.write(len);
  process.stdout.write(wav);
  process.exit(0);
});
