// Curated catalog of whisper.cpp models offered in the Settings → Transcribe
// group. Single source of truth: the API ships this list to the frontend
// (so the model picker isn't duplicated client-side) AND it doubles as the
// allow-list that gates the install/switch endpoints — only a name present
// here may be passed to the install shell script or activated, which keeps
// arbitrary strings out of `download-ggml-model.sh` and the model path.
//
// `name` is the whisper.cpp model id (what download-ggml-model.sh expects);
// the on-disk file is always `ggml-<name>.bin`.

export const WHISPER_MODELS = [
  { name: 'tiny.en-q5_1', label: 'Tiny (English)', sizeLabel: '~32 MB' },
  { name: 'base.en-q5_1', label: 'Base (English)', sizeLabel: '~60 MB' },
  { name: 'small.en-q5_1', label: 'Small (English)', sizeLabel: '~182 MB' },
  { name: 'medium.en-q5_0', label: 'Medium (English)', sizeLabel: '~539 MB' },
  { name: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo', sizeLabel: '~574 MB' },
  { name: 'large-v3-q5_0', label: 'Large v3', sizeLabel: '~1.1 GB' },
];

export const DEFAULT_MODEL = 'small.en-q5_1';

export function isKnownModel(name) {
  return WHISPER_MODELS.some(m => m.name === name);
}

export function modelFileName(name) {
  return `ggml-${name}.bin`;
}
