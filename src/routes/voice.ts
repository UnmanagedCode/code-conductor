import express from 'express';
import { promises as fs } from 'node:fs';
import { isAvailable as transcribeAvailable, transcribe, modelPathForName } from '../transcribe.ts';
import { WHISPER_MODELS, isKnownModel, DEFAULT_MODEL } from '../whisperModels.ts';
import { isAvailable as ttsAvailable, synthesize, voicePathForName } from '../tts.ts';
import { TTS_VOICES, isKnownVoice, DEFAULT_VOICE } from '../ttsModels.ts';
import {
  getTranscribeModel, setTranscribeModel, getTtsEnabled, setTtsEnabled, getTtsVoice, setTtsVoice, getTtsRate, setTtsRate,
} from '../appSettings.ts';
import * as whisperInstall from '../whisperInstall.ts';
import * as ttsInstall from '../ttsInstall.ts';
import { httpError } from '../httpError.ts';
import { jsonBody } from './shared.ts';

// Mounts the four parallel routes shared by the Settings → Transcribe and
// Settings → TTS groups: GET the catalog state, POST to switch the active item
// (allow-list + on-disk gate), POST to start an install, GET install status.
// cfg.itemKey ('model' | 'voice') drives the URL segment, the request-body
// field, and the active/list state keys; the on-disk-before-activate check is
// the allow-list enforcement point.
interface InstallableCatalogCfg {
  prefix: string;
  itemKey: string;
  // Only `name` is read here; the rest flows through `{...it, installed}`.
  // Typed as the bare `{ name: string }` (not an index-signature record)
  // because the catalog entries are declared `interface`s, which have no
  // implicit index signature.
  catalog: ReadonlyArray<{ name: string }>;
  pathForName: (name: string) => string;
  isKnown: (name: unknown) => boolean;
  getActive: () => string | null;
  setActive: (name: string) => Promise<unknown>;
  defaultName: string;
  available: () => Promise<boolean>;
  installer: { start: (name: string) => { started: boolean; running: boolean }; status: () => unknown };
  extraState?: () => Record<string, unknown>;
}
function mountInstallableCatalog(r: express.Router, cfg: InstallableCatalogCfg): { state: () => Promise<Record<string, unknown>> } {
  const { prefix, itemKey, catalog, pathForName, isKnown, getActive, setActive,
          defaultName, available, installer, extraState } = cfg;
  const activeKey = `active${itemKey[0].toUpperCase()}${itemKey.slice(1)}`;
  const listKey = `${itemKey}s`;

  async function state(): Promise<Record<string, unknown>> {
    const items = await Promise.all(catalog.map(async (it) => {
      let installed = false;
      try { installed = (await fs.stat(pathForName(it.name))).isFile(); } catch { /* missing */ }
      return { ...it, installed };
    }));
    return {
      available: await available(),
      [activeKey]: getActive() || defaultName,
      [listKey]: items,
      install: installer.status(),
      ...(extraState ? extraState() : {}),
    };
  }

  r.get(`/settings/${prefix}`, async (_req, res, next) => {
    try { res.json(await state()); } catch (e) { next(e); }
  });

  r.post(`/settings/${prefix}/${itemKey}`, async (req, res, next) => {
    try {
      const name = jsonBody(req)[itemKey];
      if (!isKnown(name)) {
        throw httpError(400, `unknown ${itemKey}`);
      }
      let onDisk = false;
      try { onDisk = (await fs.stat(pathForName(name as string))).isFile(); } catch { /* missing */ }
      if (!onDisk) {
        throw httpError(400, `${itemKey} not installed — install it first`);
      }
      await setActive(name as string);
      res.json(await state());
    } catch (e) { next(e); }
  });

  r.post(`/settings/${prefix}/install`, async (req, res, next) => {
    try {
      const result = installer.start(jsonBody(req)[itemKey] as string);
      if (!result.started) return res.status(409).json({ ok: false, running: true });
      res.json({ ok: true, started: true });
    } catch (e) { next(e); }
  });

  r.get(`/settings/${prefix}/install/status`, (_req, res) => {
    res.json(installer.status());
  });

  // Returned so sibling routes (e.g. tts /prefs) can reuse the exact state shape.
  return { state };
}

export function mountTranscribe(r: express.Router): void {
  // Voice dictation: the composer's mic button streams a recorded audio
  // blob here, the server runs whisper.cpp locally and returns the text.
  // /status drives the frontend's button-visibility — both binaries must
  // be present or the mic button stays hidden.
  r.get('/transcribe/status', async (_req, res, next) => {
    try {
      const available = await transcribeAvailable();
      res.json({ available });
    } catch (e) { next(e); }
  });

  r.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res, next) => {
    try {
      if (!(await transcribeAvailable())) {
        throw httpError(503, 'whisper.cpp not installed — run bin/install-whisper.sh');
      }
      const text = await transcribe(req.body as Buffer);
      res.json({ text });
    } catch (e) { next(e); }
  });

  // Settings → Transcribe group. Reports the curated model catalog (with
  // per-model on-disk presence), the active model (the explicit choice else the
  // built-in default, per resolveModelPath), and lets the UI switch models /
  // kick off an install of whisper.cpp + a chosen model.
  mountInstallableCatalog(r, {
    prefix: 'transcribe',
    itemKey: 'model',
    catalog: WHISPER_MODELS,
    pathForName: modelPathForName,
    isKnown: isKnownModel,
    getActive: getTranscribeModel,
    setActive: setTranscribeModel,
    defaultName: DEFAULT_MODEL,
    available: transcribeAvailable,
    installer: whisperInstall,
  });
}

export function mountTts(r: express.Router): void {
  // Text-to-speech: the conversation's 🔊 button (and auto-speak) POSTs the
  // assistant's text here; the server runs Piper locally and streams the
  // synthesized audio back sentence-by-sentence. /status drives the button's
  // visibility — the piper venv + the active voice must be present.
  r.get('/tts/status', async (_req, res, next) => {
    try {
      const available = await ttsAvailable();
      res.json({ available });
    } catch (e) { next(e); }
  });

  // Streaming synthesis. Body is the raw text (route-scoped text parser so the
  // global express.json body limit doesn't apply). The response body is a sequence of
  // [4-byte LE length][WAV] frames, one per sentence, flushed as Piper yields
  // them so the client can start playing the first sentence immediately.
  r.post('/tts', express.text({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    try {
      if (!(await ttsAvailable())) {
        throw httpError(503, 'piper not installed — run bin/install-piper.sh');
      }
      const text = typeof req.body === 'string' ? req.body : '';
      const child = synthesize(text); // throws 400 on empty text
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');

      let errBuf = '';
      child.stderr.on('data', (b) => { errBuf += b.toString(); });
      child.stdout.pipe(res);
      child.on('error', (err) => {
        if (!res.headersSent) res.status(500);
        res.end();
        void err;
      });
      child.on('close', (code) => {
        if (code !== 0 && !res.writableEnded) {
          // Piper failed mid-stream; nothing useful to send as a body now.
          res.end();
        }
        void errBuf;
      });
      // If the client disconnects, stop synthesizing.
      res.on('close', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
    } catch (e) { next(e); }
  });

  // Settings → TTS group. Reports the curated voice catalog (with per-voice
  // on-disk presence), the active voice, the auto-speak/rate prefs, and lets
  // the UI switch voices / kick off an install of piper + a chosen voice.
  const tts = mountInstallableCatalog(r, {
    prefix: 'tts',
    itemKey: 'voice',
    catalog: TTS_VOICES,
    pathForName: voicePathForName,
    isKnown: isKnownVoice,
    getActive: getTtsVoice,
    setActive: setTtsVoice,
    defaultName: DEFAULT_VOICE,
    available: ttsAvailable,
    installer: ttsInstall,
    extraState: () => ({ enabled: getTtsEnabled(), rate: getTtsRate() }),
  });

  // Persist the auto-speak toggle and/or playback rate.
  r.post('/settings/tts/prefs', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      if (body.enabled !== undefined) await setTtsEnabled(body.enabled);
      if (body.rate !== undefined) await setTtsRate(body.rate);
      res.json(await tts.state());
    } catch (e) { next(e); }
  });
}
