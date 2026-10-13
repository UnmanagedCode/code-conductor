import * as React from 'react';
import { CheckIcon, DownloadIcon, LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { voiceStore } from '@/features/voice/store';
import { cn } from '@/lib/utils';
import { SectionIntro, SettingsCard, Status, LogBox, RangeField } from './ui';
import { ApiError, apiFetch } from '@shared/http';
import { json, post, errText } from './api';

const POLL_MS = 1500;

type Item = { name: string; label: string; sizeLabel: string; installed: boolean };
type Catalog = { available: boolean; active: string | null; items: Item[]; installRunning: boolean; raw: any };

/** The two catalogs differ only in endpoint names and nouns. */
export type CatalogKind = {
  base: string;          // /api/settings/transcribe | /api/settings/tts
  pickPath: string;      // /model | /voice
  pickKey: string;       // model | voice
  listKey: string;       // models | voices
  activeKey: string;     // activeModel | activeVoice
  okLabel: string;       // Whisper available
  missingLabel: string;  // Whisper not installed — pick a model…
  activeNoun: string;    // model | voice
  buildNote: string;
};

export const DICTATION: CatalogKind = {
  base: '/api/settings/transcribe', pickPath: '/model', pickKey: 'model', listKey: 'models', activeKey: 'activeModel',
  okLabel: 'Whisper available', missingLabel: 'Whisper not installed. Pick a model and install it.', activeNoun: 'model',
  buildNote: 'The first install also builds whisper.cpp from source, which can take several minutes.',
};
export const SPEECH: CatalogKind = {
  base: '/api/settings/tts', pickPath: '/voice', pickKey: 'voice', listKey: 'voices', activeKey: 'activeVoice',
  okLabel: 'Speech available', missingLabel: 'Piper not installed. Pick a voice and install it.', activeNoun: 'voice',
  buildNote: 'The first install also builds Piper from source, which can take several minutes.',
};

function toCatalog(kind: CatalogKind, d: any): Catalog {
  return { available: !!d.available, active: d[kind.activeKey] ?? null, items: d[kind.listKey] || [], installRunning: !!d.install?.running, raw: d };
}

/**
 * A curated catalog with per-item on-disk state: pick an installed item to make
 * it active; pick a missing one to offer its install, which runs server-side
 * while this polls the log.
 */
export function InstallableCatalog({ kind, onAvailability, onData, children }: {
  kind: CatalogKind; onAvailability: (available: boolean) => void; onData?: (raw: any) => void; children?: React.ReactNode;
}) {
  const [cat, setCat] = React.useState<Catalog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [installing, setInstalling] = React.useState(false);
  const [log, setLog] = React.useState('');
  const [hint, setHint] = React.useState('');
  const alive = React.useRef(true);
  const onDataRef = React.useRef(onData);
  onDataRef.current = onData;

  const load = React.useCallback(async () => {
    try {
      const d = await json(kind.base);
      if (!alive.current) return null;
      setCat(toCatalog(kind, d));
      onDataRef.current?.(d);
      setError(null);
      return d;
    } catch (e) {
      if (alive.current) setError(`Failed to load: ${errText(e)}`);
      return null;
    }
  }, [kind]);

  const poll = React.useCallback(async () => {
    if (!alive.current) return;
    let s: any;
    try {
      s = await json(`${kind.base}/install/status`);
    } catch {
      setTimeout(poll, POLL_MS);
      return;
    }
    if (!alive.current) return;
    setLog(s.log || '');
    if (s.running) {
      setTimeout(poll, POLL_MS);
    } else {
      setInstalling(false);
      setHint('');
      const d = await load();
      if (d) onAvailability(!!d.available);
    }
  }, [kind, load, onAvailability]);

  const beginPoll = React.useCallback(() => {
    setInstalling(true);
    setSelected(null);
    setHint('Installing…');
    void poll();
  }, [poll]);

  React.useEffect(() => {
    alive.current = true;
    void load().then((d) => { if (d?.install?.running) beginPoll(); });
    return () => { alive.current = false; };
  }, [load, beginPoll]);

  async function pick(item: Item) {
    if (installing) return;
    setSelected(item.name);
    if (!item.installed) { setHint(kind.buildNote); return; }
    if (item.name === cat?.active) { setHint(''); return; }
    setHint('Switching…');
    try {
      const d = await post(`${kind.base}${kind.pickPath}`, { [kind.pickKey]: item.name });
      setSelected(null);
      setHint('');
      setCat(toCatalog(kind, d));
      onDataRef.current?.(d);
      onAvailability(!!d.available);
    } catch (e) {
      setHint(`Switch failed: ${errText(e)}`);
    }
  }

  async function install(item: Item) {
    setLog('');
    try {
      await apiFetch(`${kind.base}/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [kind.pickKey]: item.name }) });
      beginPoll();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setHint('An install is already running.');
        beginPoll();
        return;
      }
      setHint(`Install failed to start: ${errText(e)}`);
    }
  }

  const sel = cat?.items.find((m) => m.name === selected) ?? null;
  const activeLabel = cat?.items.find((m) => m.name === cat.active)?.label;

  return (
    <div className="space-y-3">
      {error ? <Status text={error} tone="error" /> : !cat ? <Status text="Loading…" /> : (
        <Status
          text={cat.available ? <>{kind.okLabel}{activeLabel && <> · active {kind.activeNoun}: <strong className="font-medium text-foreground">{activeLabel}</strong></>}</> : kind.missingLabel}
          tone={cat.available ? 'ok' : 'muted'}
        />
      )}
      {children}
      {cat && (
        <ul className="grid gap-2 @3xl:grid-cols-2" role="listbox" aria-label={`${kind.activeNoun} catalog`}>
          {cat.items.map((m) => {
            const isActive = m.name === cat.active && m.installed;
            return (
              <li key={m.name} className="min-w-0">
                <button
                  type="button"
                  role="option"
                  aria-selected={m.name === selected || isActive}
                  disabled={installing}
                  onClick={() => void pick(m)}
                  data-item={m.name}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    isActive ? 'border-primary/40 bg-primary/6' : 'hover:bg-muted/60',
                    m.name === selected && !isActive && 'ring-2 ring-ring/50',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium break-words">{m.label}</div>
                    <div className="text-xs text-muted-foreground">{m.sizeLabel}</div>
                  </div>
                  {isActive ? <Badge><CheckIcon /> active</Badge>
                    : m.installed ? <Badge variant="secondary">installed</Badge>
                    : <Badge variant="outline" className="text-muted-foreground">not installed</Badge>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {sel && !sel.installed && !installing && (
          <Button onClick={() => void install(sel)}><DownloadIcon /> Install {sel.label} ({sel.sizeLabel})</Button>
        )}
        {installing && <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />}
        {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </div>
      <LogBox text={log} />
    </div>
  );
}

function SpeechPrefs({ raw }: { raw: any }) {
  const [enabled, setEnabled] = React.useState<boolean>(!!raw?.enabled);
  const [rate, setRate] = React.useState<number>(Number(raw?.rate) || 1);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (raw?.enabled !== undefined) setEnabled(!!raw.enabled);
    if (raw?.rate !== undefined) setRate(Number(raw.rate));
  }, [raw]);
  async function save(p: { enabled?: boolean; rate?: number }) {
    try {
      const d = await post('/api/settings/tts/prefs', p);
      setErr(null);
      voiceStore.set({ ttsEnabled: !!d.enabled, ttsRate: Number(d.rate) || 1 });
    } catch (e) {
      setErr(`Save failed: ${errText(e)}`);
    }
  }
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3">
      <Label className="font-normal">
        <Switch checked={enabled} disabled={!raw?.available} aria-label="Auto-speak assistant replies" onCheckedChange={(v) => { setEnabled(v); void save({ enabled: v }); }} />
        Auto-speak assistant replies
      </Label>
      <RangeField id="tts-rate" label="Rate" min={0.5} max={2} step={0.05} value={rate} format={(v) => `${v.toFixed(2)}×`} onInput={setRate} onCommit={(v) => void save({ rate: v })} />
      <Status text={err} tone="error" />
    </div>
  );
}

export function VoiceSection() {
  const [ttsRaw, setTtsRaw] = React.useState<any>(null);
  const setMic = React.useCallback((v: boolean) => voiceStore.set({ micAvailable: v }), []);
  const setTts = React.useCallback((v: boolean) => voiceStore.set({ ttsAvailable: v }), []);
  return (
    <div className="space-y-6">
      <SectionIntro title="Voice">Dictation and speech both run locally on the server, with no network and no API key.</SectionIntro>
      <SettingsCard title="Dictation" description="Tap the composer's mic (or hold Send) to dictate. Speech is transcribed by whisper.cpp on the server. Install it and pick a model.">
        <InstallableCatalog kind={DICTATION} onAvailability={setMic} />
      </SettingsCard>
      <SettingsCard title="Speech" description="Read assistant replies aloud with Piper, a local neural text-to-speech engine. Use the read-aloud button on a reply, or turn on auto-speak to hear each reply as it finishes.">
        <InstallableCatalog kind={SPEECH} onAvailability={setTts} onData={setTtsRaw}>
          <SpeechPrefs raw={ttsRaw} />
        </InstallableCatalog>
      </SettingsCard>
    </div>
  );
}
