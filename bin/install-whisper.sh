#!/usr/bin/env bash
# One-shot installer for the composer's voice-dictation feature.
# Builds whisper.cpp under ~/.code-conductor/whisper.cpp and downloads
# the recommended quantized English model. Total disk cost ~90 MB.
#
# Re-run safely: clone is git pull on existing checkout, model download
# script is idempotent.

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.code-conductor}"
WHISPER_DIR="$INSTALL_ROOT/whisper.cpp"
MODEL="${WHISPER_MODEL_NAME:-base.en-q5_1}"

echo "==> Installing system deps (ffmpeg, clang, make, cmake, git)"
if command -v pkg >/dev/null 2>&1; then
  pkg install -y ffmpeg clang make cmake git
elif command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y ffmpeg clang make cmake git
else
  echo "WARN: no known package manager (pkg/apt-get) — install ffmpeg clang make cmake git manually" >&2
fi

mkdir -p "$INSTALL_ROOT"
cd "$INSTALL_ROOT"

if [ -d "$WHISPER_DIR/.git" ]; then
  echo "==> Updating whisper.cpp checkout"
  git -C "$WHISPER_DIR" pull --ff-only || echo "WARN: git pull failed, continuing with existing checkout"
else
  echo "==> Cloning whisper.cpp"
  git clone https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"

echo "==> Building whisper-cli (cmake Release)"
cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build build --config Release -j"$(nproc 2>/dev/null || echo 2)"

echo "==> Downloading model: $MODEL"
bash ./models/download-ggml-model.sh "$MODEL"

CLI_PATH="$WHISPER_DIR/build/bin/whisper-cli"
MODEL_PATH="$WHISPER_DIR/models/ggml-${MODEL}.bin"

if [ ! -x "$CLI_PATH" ]; then
  echo "ERROR: build finished but $CLI_PATH not found" >&2
  exit 1
fi
if [ ! -f "$MODEL_PATH" ]; then
  echo "ERROR: model download finished but $MODEL_PATH not found" >&2
  exit 1
fi

cat <<EOF

==> Done.

Defaults already point at:
  WHISPER_CLI   = $CLI_PATH
  WHISPER_MODEL = $MODEL_PATH

To use a different model or paths, export these before starting the server:
  export WHISPER_CLI="$CLI_PATH"
  export WHISPER_MODEL="$MODEL_PATH"

Restart code-conductor and the mic button will appear in the composer.
EOF
