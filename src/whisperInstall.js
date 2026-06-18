// Drives bin/install-whisper.sh from the web UI (Settings → Transcribe).
// One install runs at a time, process-wide; stdout+stderr are captured into a
// bounded in-memory ring so the frontend can poll progress. On a clean exit
// the freshly-installed model is persisted as the active transcribe model.
//
// The script path is overridable via WHISPER_INSTALL_SCRIPT (test injection,
// mirroring the CLAUDE_BIN fake-binary convention). The selected model name
// is gated against the whisperModels allow-list before it ever reaches the
// shell. All the shared singleton mechanics live in installRunner.js; this
// module is just the whisper-specific config + the public re-exports.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInstallRunner } from './installRunner.js';
import { isKnownModel } from './whisperModels.js';
import { setTranscribeModel } from './appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(__dirname, '..', 'bin', 'install-whisper.sh');

export const { start, status, isRunning, _reset } = makeInstallRunner({
  scriptDefault: DEFAULT_SCRIPT,
  scriptEnvVar: 'WHISPER_INSTALL_SCRIPT',
  childEnvVar: 'WHISPER_MODEL_NAME',
  validate: isKnownModel,
  persist: setTranscribeModel,
  itemKey: 'model',
  unknownNoun: 'whisper model',
  startLabel: 'whisper.cpp + model',
});
