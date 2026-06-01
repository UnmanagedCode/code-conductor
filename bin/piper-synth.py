#!/usr/bin/env python3
"""Streaming Piper synthesizer used by src/tts.js.

Reads UTF-8 text from stdin, loads the given Piper voice once, and writes one
self-contained WAV per *sentence* to stdout as Piper yields it — each framed as
a 4-byte little-endian length prefix followed by the WAV bytes. Flushing per
sentence is what lets the browser start playing the first sentence (~0.3s) while
the rest are still synthesizing.

Wire format (repeated, one frame per sentence):
    [uint32 LE: len(wav)] [wav bytes]

PiperVoice.synthesize() yields AudioChunk objects exposing audio_int16_bytes +
sample_rate / sample_width / sample_channels; we wrap each chunk's PCM in a WAV
container via the stdlib `wave` module so the client can decodeAudioData() it
directly.
"""

import argparse
import io
import struct
import sys
import wave


def wav_bytes(pcm, sample_rate, sample_width, channels):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sample_width)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--length-scale", type=float, default=1.0)
    args = ap.parse_args()

    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    if not text:
        return 0

    # Imported lazily so --help / argparse errors don't require the venv deps.
    from piper import PiperVoice

    try:
        from piper import SynthesisConfig
        syn_config = SynthesisConfig(length_scale=args.length_scale)
    except Exception:
        syn_config = None

    voice = PiperVoice.load(args.model, config_path=args.config)

    out = sys.stdout.buffer
    chunks = voice.synthesize(text, syn_config) if syn_config is not None else voice.synthesize(text)
    for chunk in chunks:
        pcm = getattr(chunk, "audio_int16_bytes", None)
        if pcm is None:
            # Older piper builds exposed a numpy array instead.
            pcm = chunk.audio_int16_array.tobytes()
        wav = wav_bytes(
            pcm,
            getattr(chunk, "sample_rate", 22050),
            getattr(chunk, "sample_width", 2),
            getattr(chunk, "sample_channels", 1),
        )
        out.write(struct.pack("<I", len(wav)))
        out.write(wav)
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
