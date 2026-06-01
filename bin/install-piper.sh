#!/usr/bin/env bash
# One-shot installer for the conversation's text-to-speech (TTS) feature.
# Builds a Piper venv under ~/.code-conductor/piper and downloads a neural
# voice. This recipe solves five non-obvious Termux/aarch64 hurdles — keep the
# explanatory comments; they're why each step exists.
#
# Re-run safely: every step self-checks "already done?" and is a fast no-op in
# steady state (venv reuse, pip idempotency, voice-file presence checks).

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.code-conductor}"
PIPER_DIR="$INSTALL_ROOT/piper"
VENV="$PIPER_DIR/venv"
VOICES_DIR="$PIPER_DIR/voices"
VOICE="${PIPER_VOICE_NAME:-en_US-lessac-medium}"

PYTHON="$VENV/bin/python3"
PIP="$VENV/bin/pip"

# manylinux aarch64 piper_tts wheel — we DON'T install it (its native .so links
# glibc and won't load on Android bionic), but we mine it for espeak-ng-data,
# which the pure-Python wheel pip installs omits.
WHEEL_URL="https://files.pythonhosted.org/packages/77/1c/260c65320df47fee582d78ad52d49d4195c5439a77b62e73306c2de835ea/piper_tts-1.4.2-cp39-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.manylinux_2_28_aarch64.whl"

# ── 1. System deps ────────────────────────────────────────────────────────
# onnxruntime has NO PyPI wheel for py3.13/aarch64; Termux splits it into a C
# library (onnxruntime) + the Python bindings (python-onnxruntime). espeak
# provides libespeak-ng.so + the headers we compile espeakbridge.c against.
echo "==> Installing system deps (onnxruntime, python-onnxruntime, espeak, clang)"
if command -v pkg >/dev/null 2>&1; then
  pkg install -y onnxruntime python-onnxruntime espeak clang
elif command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y espeak-ng clang
  echo "WARN: non-Termux host — ensure onnxruntime python bindings are importable" >&2
else
  echo "WARN: no known package manager — install onnxruntime python-onnxruntime espeak clang manually" >&2
fi

mkdir -p "$PIPER_DIR" "$VOICES_DIR"

# ── 2. venv (with system site-packages) ─────────────────────────────────────
# --system-site-packages is REQUIRED so the venv can see the pkg-installed
# python-onnxruntime (there's no pip-installable onnxruntime for this target).
if [ ! -x "$PYTHON" ]; then
  echo "==> Creating venv at $VENV"
  python3 -m venv --system-site-packages "$VENV"
else
  echo "==> Reusing existing venv at $VENV"
fi

# ── 3. pip install piper-tts (no build isolation) ───────────────────────────
# Without scikit-build/setuptools/wheel present + --no-build-isolation, pip
# tries to build the `cmake` PyPI package from source (slow, fails on Termux).
# --no-build-isolation makes the build use the system cmake instead.
if ! "$PYTHON" -c "import piper" >/dev/null 2>&1; then
  echo "==> Installing piper-tts into the venv"
  "$PIP" install --upgrade pip >/dev/null
  "$PIP" install scikit-build setuptools wheel
  "$PIP" install piper-tts --no-build-isolation
else
  echo "==> piper-tts already importable — skipping pip install"
fi

SITE="$("$PYTHON" -c 'import piper, os; print(os.path.dirname(piper.__file__))')"
echo "==> piper package at $SITE"

# ── 4. espeak-ng-data (mined from the manylinux wheel) ──────────────────────
# Piper phonemizes via its bundled espeak-ng fork's data files; the pure-Python
# wheel pip installed omits espeak-ng-data, so pull it from the manylinux wheel.
if [ ! -d "$SITE/espeak-ng-data" ]; then
  echo "==> Fetching espeak-ng-data from the manylinux wheel"
  TMP_WHEEL="$PIPER_DIR/piper_tts-manylinux.whl"
  if [ ! -f "$TMP_WHEEL" ]; then
    curl -L --fail -o "$TMP_WHEEL" "$WHEEL_URL"
  fi
  "$PYTHON" - "$TMP_WHEEL" "$SITE" <<'PY'
import sys, zipfile, os
wheel, site = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(wheel) as z:
    members = [n for n in z.namelist() if "/espeak-ng-data/" in n or n.startswith("piper/espeak-ng-data/")]
    base = os.path.dirname(site)  # site is .../piper ; extract relative to its parent
    for n in members:
        z.extract(n, base)
print(f"extracted {len(members)} espeak-ng-data members")
PY
  rm -f "$TMP_WHEEL"
else
  echo "==> espeak-ng-data already present — skipping"
fi

# ── 5. Build espeakbridge.so natively against Termux libespeak-ng ───────────
# The manylinux wheel's espeakbridge.*.so links glibc and won't load on Android
# bionic, so we compile our own against Termux's libespeak-ng. The upstream
# bridge calls espeak_TextToPhonemesWithTerminator — a piper1-gpl fork addition
# absent from Termux espeak-ng 1.52.0 — so we PATCH it to the standard 3-arg
# espeak_TextToPhonemes, treating each returned chunk as a full sentence
# boundary (no terminator info is available from the stock API).
BRIDGE_SO="$SITE/espeakbridge.abi3.so"
if [ ! -f "$BRIDGE_SO" ]; then
  echo "==> Building patched espeakbridge.abi3.so"
  BRIDGE_SRC="$PIPER_DIR/espeakbridge.c"
  cat > "$BRIDGE_SRC" <<'EOF'
// Patched for Termux/aarch64: derived from piper1-gpl's espeakbridge.c, with
// espeak_TextToPhonemesWithTerminator (a fork-only addition, missing from
// Termux espeak-ng 1.52.0) replaced by the standard 3-arg espeak_TextToPhonemes.
// The stock API reports no clause terminator, so every returned chunk is
// emitted as a full sentence (period terminator, sentence-boundary = True).
#define Py_LIMITED_API 0x03090000
#include <Python.h>
#include <espeak-ng/speak_lib.h>

static PyObject *py_initialize(PyObject *self, PyObject *args) {
    const char *data_dir;
    if (!PyArg_ParseTuple(args, "s", &data_dir)) {
        return NULL;
    }
    if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data_dir, 0) < 0) {
        PyErr_SetString(PyExc_RuntimeError, "Failed to initialize espeak-ng");
        return NULL;
    }
    Py_RETURN_NONE;
}

static PyObject *py_set_voice(PyObject *self, PyObject *args) {
    const char *voice;
    if (!PyArg_ParseTuple(args, "s", &voice)) {
        return NULL;
    }
    if (espeak_SetVoiceByName(voice) != EE_OK) {
        PyErr_Format(PyExc_RuntimeError, "Failed to set voice: %s", voice);
        return NULL;
    }
    Py_RETURN_NONE;
}

static PyObject *py_get_phonemes(PyObject *self, PyObject *args) {
    const char *text;
    if (!PyArg_ParseTuple(args, "s", &text)) {
        return NULL;
    }

    PyObject *phonemes_and_terminators = PyList_New(0);

    while (text != NULL) {
        // Stock espeak-ng 3-arg phonemizer: advances `text`, returns IPA
        // phonemes for the next clause, sets `text` to NULL when done. No
        // terminator is reported, so treat each chunk as a sentence: ".",
        // sentence-boundary True.
        const char *phonemes = espeak_TextToPhonemes(
            (const void **)&text, espeakCHARS_AUTO, espeakPHONEMES_IPA);

        PyList_Append(phonemes_and_terminators,
                      Py_BuildValue("(ssO)", phonemes, ".", Py_True));
    }

    return phonemes_and_terminators;
}

static PyMethodDef methods[] = {
    {"initialize", py_initialize, METH_VARARGS, "Initialize espeak-ng"},
    {"set_voice", py_set_voice, METH_VARARGS, "Set voice by name"},
    {"get_phonemes", py_get_phonemes, METH_VARARGS, "Get phonemes from text"},
    {NULL, NULL, 0, NULL}};

static struct PyModuleDef module = {PyModuleDef_HEAD_INIT, "espeakbridge", NULL,
                                    -1, methods};

PyMODINIT_FUNC PyInit_espeakbridge(void) { return PyModule_Create(&module); }
EOF
  PYINC="$("$PYTHON" -c 'import sysconfig; print(sysconfig.get_path("include"))')"
  PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
  # Remove any prebuilt (glibc-linked) bridge so our .so wins import resolution.
  rm -f "$SITE"/espeakbridge*.so
  clang -shared -fPIC -DPy_LIMITED_API=0x03090000 \
    -I"$PYINC" -I"$PREFIX/include" -L"$PREFIX/lib" \
    "$BRIDGE_SRC" -o "$BRIDGE_SO" -lespeak-ng
  echo "==> Built $BRIDGE_SO"
else
  echo "==> espeakbridge already built — skipping"
fi

# ── 6. Download the voice ───────────────────────────────────────────────────
# HF layout: rhasspy/piper-voices/<lang>/<lang_REGION>/<speaker>/<quality>/<name>.onnx[.json]
LANG_REGION="${VOICE%%-*}"          # en_US
REST="${VOICE#*-}"                  # lessac-medium
SPEAKER="${REST%%-*}"               # lessac
QUALITY="${REST##*-}"               # medium
LANG="${LANG_REGION%%_*}"           # en
HFDIR="$LANG/$LANG_REGION/$SPEAKER/$QUALITY"
HF_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/$HFDIR"
ONNX="$VOICES_DIR/$VOICE.onnx"
JSON="$VOICES_DIR/$VOICE.onnx.json"

echo "==> Downloading voice: $VOICE"
[ -f "$ONNX" ] || curl -L --fail -o "$ONNX" "$HF_BASE/$VOICE.onnx"
[ -f "$JSON" ] || curl -L --fail -o "$JSON" "$HF_BASE/$VOICE.onnx.json"

# ── Smoke test ──────────────────────────────────────────────────────────────
echo "==> Smoke test: synthesize a short phrase"
"$PYTHON" - "$ONNX" "$JSON" <<'PY'
import sys, wave, io
from piper import PiperVoice
voice = PiperVoice.load(sys.argv[1], config_path=sys.argv[2])
got = False
for chunk in voice.synthesize("Piper text to speech is working."):
    pcm = getattr(chunk, "audio_int16_bytes", None) or chunk.audio_int16_array.tobytes()
    if pcm:
        got = True
        break
assert got, "synthesis produced no audio"
print("OK: synthesis produced audio")
PY

cat <<EOF

==> Done.

Installed:
  PIPER_PYTHON = $PYTHON
  PIPER_VOICE  = $ONNX

To use a different voice or paths, export these before starting the server:
  export PIPER_PYTHON="$PYTHON"
  export PIPER_VOICE="$ONNX"

Restart code-conductor and the 🔊 speak button will appear on assistant messages.
EOF
