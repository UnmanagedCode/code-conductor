// Drives bin/install-piper.sh from the web UI (Settings → TTS). One install
// runs at a time, process-wide; stdout+stderr are captured into a bounded
// in-memory ring so the frontend can poll progress. On a clean exit the
// freshly-installed voice is persisted as the active TTS voice.
//
// The script path is overridable via PIPER_INSTALL_SCRIPT (test injection,
// mirroring the CLAUDE_BIN fake-binary convention). The selected voice name is
// gated against the ttsModels allow-list before it ever reaches the shell. All
// the shared singleton mechanics live in installRunner.js; this module is just
// the piper-specific config + the public re-exports.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInstallRunner } from './installRunner.js';
import { isKnownVoice } from './ttsModels.js';
import { setTtsVoice } from './appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(__dirname, '..', 'bin', 'install-piper.sh');

export const { start, status, isRunning, _reset } = makeInstallRunner({
  scriptDefault: DEFAULT_SCRIPT,
  scriptEnvVar: 'PIPER_INSTALL_SCRIPT',
  childEnvVar: 'PIPER_VOICE_NAME',
  validate: isKnownVoice,
  persist: setTtsVoice,
  itemKey: 'voice',
  unknownNoun: 'piper voice',
  startLabel: 'Piper + voice',
});
