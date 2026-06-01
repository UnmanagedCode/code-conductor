// Curated catalog of Piper voices offered in the Settings → TTS group.
// Single source of truth: the API ships this list to the frontend (so the
// voice picker isn't duplicated client-side) AND it doubles as the allow-list
// that gates the install/switch endpoints — only a name present here may be
// passed to the install shell script or activated, which keeps arbitrary
// strings out of the download URL and the voice path.
//
// `name` is the Piper voice id (HF rhasspy/piper-voices file stem); the
// on-disk files are `<name>.onnx` (model) + `<name>.onnx.json` (config).
// `hfDir` is the voice's subdirectory under the HF repo, stored explicitly so
// the installer needn't parse the name (parsing is fragile across regions).

export const TTS_VOICES = [
  { name: 'en_US-lessac-medium', label: 'Lessac (US, medium)', sizeLabel: '~63 MB', hfDir: 'en/en_US/lessac/medium' },
  { name: 'en_US-amy-medium',    label: 'Amy (US, medium)',    sizeLabel: '~63 MB', hfDir: 'en/en_US/amy/medium' },
  { name: 'en_US-ryan-high',     label: 'Ryan (US, high)',     sizeLabel: '~114 MB', hfDir: 'en/en_US/ryan/high' },
  { name: 'en_GB-alba-medium',   label: 'Alba (GB, medium)',   sizeLabel: '~63 MB', hfDir: 'en/en_GB/alba/medium' },
];

export const DEFAULT_VOICE = 'en_US-lessac-medium';

export function isKnownVoice(name) {
  return TTS_VOICES.some(v => v.name === name);
}

// The model file stem; the config sidecar is always `${voiceFileName(name)}.json`.
export function voiceFileName(name) {
  return `${name}.onnx`;
}
