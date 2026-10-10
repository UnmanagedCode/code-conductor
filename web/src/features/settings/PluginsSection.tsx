import * as React from 'react';
import { DownloadIcon, LoaderCircleIcon, PlayIcon, PlugIcon, PowerIcon, RefreshCwIcon, RotateCwIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { SectionIntro, SettingsCard, Status, LogBox } from './ui';
import { json, post, errText, streamAction, capLog, HttpError } from './api';
import { notifyPluginsChanged, type PluginsChange } from './pluginsSignal';
import {
  backendLocalOnly, contributions, hookWarning, isUsable, metaBits, updateChange, updateWarning,
  type LibraryEntry, type PluginRow, type UpdateResult,
} from './pluginLogic';
import { createStore, useStore } from '@/state/createStore';

const STATE_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'info'> = {
  ready: 'success', starting: 'info', stopped: 'secondary', disabled: 'secondary', crashed: 'destructive', failed: 'destructive',
  invalid: 'destructive', incompatible: 'warning', conflict: 'warning',
};

type Tone = { text: string; error?: boolean } | null;

// The running library action lives at module scope, not in the section: an
// Update all keeps running after Settings is left, and a remounted section must
// still show it and keep every other action locked.
const pluginsBusyStore = createStore<{ busyEntry: { id: string; label: string } | null; updatingAll: string | null }>({ busyEntry: null, updatingAll: null });
const setBusyEntry = (busyEntry: { id: string; label: string } | null) => pluginsBusyStore.set({ busyEntry });
const setUpdatingAll = (updatingAll: string | null) => pluginsBusyStore.set({ updatingAll });

export function PluginsSection() {
  const [rows, setRows] = React.useState<PluginRow[] | null>(null);
  const [worktrees, setWorktrees] = React.useState<Record<string, string[]>>({});
  const [library, setLibrary] = React.useState<LibraryEntry[] | null>(null);
  const [status, setStatus] = React.useState<Tone>({ text: 'Loading…' });
  const [libStatus, setLibStatus] = React.useState<Tone>({ text: 'Loading…' });
  const [libTail, setLibTail] = React.useState('');
  const [live, setLive] = React.useState<Record<string, string>>({});
  const { busyEntry, updatingAll } = useStore(pluginsBusyStore, (s) => s);
  const busy = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const [plugins, projects, lib] = await Promise.all([
        json<{ rows: PluginRow[]; notices?: { file: string; reason: string; backup?: string }[] }>('/api/plugins'),
        json<any[]>('/api/projects').catch(() => []),
        json<{ entries: LibraryEntry[]; skipped?: { dir: string; file: string | null; reason: string }[] }>('/api/plugins/library'),
      ]);
      const wt: Record<string, string[]> = {};
      for (const p of projects) wt[p.name] = (p.worktrees || []).map((w: any) => w.worktreeName).filter(Boolean);
      setWorktrees(wt);
      setRows(plugins.rows);
      setLibrary(lib.entries);
      if (plugins.notices?.length) {
        setStatus({ error: true, text: plugins.notices.map((n) => `${n.file} was unreadable (${n.reason})${n.backup ? ` — moved aside to ${n.backup}; plugin enable/version state was reset` : ''}`).join(' · ') });
      } else {
        setStatus({ text: plugins.rows.length ? `${plugins.rows.length} plugin${plugins.rows.length === 1 ? '' : 's'}` : 'No plugins found. A plugin is a project with a conductor.plugin.json at its root.' });
      }
      if (lib.skipped?.length) {
        setLibStatus({ error: true, text: `Skipped ${lib.skipped.length} library drop-in(s): ${lib.skipped.map((s) => (s.file === null ? `${s.dir} (${s.reason})` : `${s.dir}/${s.file} (${s.reason})`)).join(', ')}` });
      } else {
        setLibStatus({ text: lib.entries.length ? `${lib.entries.length} available` : 'No library entries.' });
      }
      return plugins.rows;
    } catch (e) {
      setStatus({ error: true, text: `Failed to load plugins: ${errText(e)}` });
      return null;
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  async function act(label: string, fn: () => Promise<unknown>, change?: PluginsChange) {
    if (busy.current) return;
    busy.current = true;
    setStatus({ text: `${label}…` });
    try {
      await fn();
      await load();
      notifyPluginsChanged(change);
    } catch (e) {
      setStatus({ error: true, text: `${label} failed: ${errText(e)}` });
    } finally {
      busy.current = false;
    }
  }

  const appendLive = (id: string) => (text: string) => setLive((l) => ({ ...l, [id]: capLog(l[id] ?? '', text) }));

  async function install(entry: LibraryEntry) {
    if (busy.current) return;
    busy.current = true;
    setBusyEntry({ id: entry.id, label: 'Installing…' });
    setLibStatus({ text: `Installing ${entry.name}…` });
    setLibTail('');
    try {
      const result = await streamAction(`/api/plugins/library/${entry.id}/install`, appendLive(entry.id));
      await load();
      notifyPluginsChanged(undefined);
      const w = hookWarning(entry.name, 'Installed', 'post-install', result?.postClone);
      if (w) { setLibStatus({ error: true, text: w.text }); setLibTail(w.tail ?? ''); }
    } catch (e) {
      setLibStatus({ error: true, text: `Installing ${entry.name} failed: ${errText(e)}` });
      if ((e as HttpError).tail) setLibTail((e as HttpError).tail!);
    } finally {
      setBusyEntry(null);
      busy.current = false;
    }
  }

  async function runUpdate(entry: LibraryEntry): Promise<{ ok: true; result: UpdateResult } | { ok: false; error: string; tail?: string }> {
    try {
      return { ok: true, result: await streamAction(`/api/plugins/library/${entry.id}/update`, appendLive(entry.id)) };
    } catch (e) {
      return { ok: false, error: errText(e), tail: (e as HttpError).tail };
    }
  }

  async function update(entry: LibraryEntry) {
    if (busy.current) return;
    busy.current = true;
    setBusyEntry({ id: entry.id, label: 'Updating…' });
    setLibStatus({ text: `Updating ${entry.name}…` });
    setLibTail('');
    try {
      const out = await runUpdate(entry);
      if (out.ok) {
        const fresh = (await load()) ?? rows ?? [];
        notifyPluginsChanged(updateChange([out.result], fresh));
        const w = updateWarning(entry.name, out.result);
        if (w) { setLibStatus({ error: true, text: w.text }); setLibTail(w.tail ?? ''); }
      } else {
        setLibStatus({ error: true, text: `Updating ${entry.name} failed: ${out.error}` });
        if (out.tail) setLibTail(out.tail);
      }
    } finally {
      setBusyEntry(null);
      busy.current = false;
    }
  }

  async function updateAll() {
    const targets = (library || []).filter((e) => e.installed && e.updateAvailable);
    if (busy.current || !targets.length) return;
    busy.current = true;
    setLibTail('');
    const outcomes: ({ name: string } & Awaited<ReturnType<typeof runUpdate>>)[] = [];
    try {
      for (const [i, entry] of targets.entries()) {
        setUpdatingAll(`Updating ${i + 1}/${targets.length}…`);
        setBusyEntry({ id: entry.id, label: 'Updating…' });
        setLibStatus({ text: `Updating ${entry.name} (${i + 1}/${targets.length})…` });
        outcomes.push({ name: entry.name, ...(await runUpdate(entry)) });
      }
      setBusyEntry(null);
      const fresh = (await load()) ?? rows ?? [];
      const ok = outcomes.filter((o): o is { name: string; ok: true; result: UpdateResult } => o.ok);
      if (ok.length) notifyPluginsChanged(updateChange(ok.map((o) => o.result), fresh));
      const problems: { name: string; text: string; tail?: string }[] = [];
      for (const o of outcomes) {
        if (!o.ok) problems.push({ name: o.name, text: `${o.name} failed: ${o.error}`, tail: o.tail });
        else {
          const w = updateWarning(o.name, o.result);
          if (w) problems.push({ name: o.name, ...w });
        }
      }
      setLibStatus({
        error: problems.length > 0,
        text: `Updated ${ok.length} of ${targets.length} plugin${targets.length === 1 ? '' : 's'}${problems.length ? ` — ${problems.map((p) => p.text).join('; ')}` : ''}`,
      });
      const tails = problems.filter((p) => p.tail);
      if (tails.length) setLibTail(tails.map((p) => `── ${p.name} ──\n${p.tail}`).join('\n\n'));
    } finally {
      setUpdatingAll(null);
      setBusyEntry(null);
      busy.current = false;
    }
  }

  const updatable = (library || []).filter((e) => e.installed && e.updateAvailable).length;
  const locked = !!busyEntry || !!updatingAll;

  return (
    <div className="space-y-6">
      <SectionIntro title="Plugins">
        Projects with a <code>conductor.plugin.json</code> run as embedded apps: a proxied backend under <code>/plugins/&lt;id&gt;/</code>, an entry in the sidebar's app switcher, and optionally MCP tools for sessions in the plugin's project. Plugins are trusted code with the same access as this UI.
      </SectionIntro>
      <SettingsCard
        title="Installed"
        action={<Button variant="outline" size="sm" disabled={locked} onClick={() => void act('Rescanning', () => post('/api/plugins/rescan'))} title="Re-scan every project for conductor.plugin.json manifests"><RefreshCwIcon /> Rescan</Button>}
      >
        <Status text={status?.text} tone={status?.error ? 'error' : 'muted'} />
        <div className="grid gap-3" data-testid="plugin-list">
          {(rows || []).map((row) => {
            const localOnly = Array.isArray(row.localOnly) ? row.localOnly : [];
            const contribs = contributions(row);
            return (
              <div key={row.id} data-plugin={row.id} className="rounded-xl border px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PlugIcon className="size-4 text-muted-foreground" />
                  <span className="font-medium">{row.name}</span>
                  <Badge variant={STATE_VARIANT[row.state] ?? 'secondary'}>{row.state}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{metaBits(row).join(' · ')}</div>
                {contribs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">{contribs.map((c) => <Badge key={c} variant="outline" className="font-normal">{c}</Badge>)}</div>
                )}
                {!!row.conventions?.length && (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {row.conventions.map((c) => (
                      <li key={c.name}><span className="font-medium">{c.hasScaffold ? `${c.name} · scaffolds` : c.name}</span> <span className="text-muted-foreground">{c.description}</span></li>
                    ))}
                  </ul>
                )}
                {!!row.errors?.length && <Status className="mt-2" text={row.errors.join('; ')} tone="error" />}
                {row.crashTail && (
                  <details className="mt-2"><summary className="cursor-pointer text-xs text-destructive">Crash output</summary><LogBox text={row.crashTail} className="mt-1" /></details>
                )}
                {isUsable(row) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {!row.enabled ? (
                      <Button size="sm" disabled={locked} onClick={() => void act(`Enabling ${row.id}`, () => post(`/api/plugins/${row.id}/enable`))}><PowerIcon /> Enable</Button>
                    ) : (
                      <>
                        {row.hasBackend && !backendLocalOnly(row) && (
                          <>
                            {row.state === 'ready' || row.state === 'starting' ? (
                              <>
                                <Button size="sm" variant="outline" disabled={locked} onClick={() => void act(`Stopping ${row.id}`, () => post(`/api/plugins/${row.id}/stop`))}><SquareIcon /> Stop</Button>
                                {row.state === 'ready' && row.stale && (
                                  <Button size="sm" variant="outline" disabled={locked} onClick={() => void act(`Restarting ${row.id}`, () => post(`/api/plugins/${row.id}/restart`), { action: 'restart', ids: [row.id] })}><RotateCwIcon /> Restart</Button>
                                )}
                              </>
                            ) : (
                              <Button size="sm" variant="outline" disabled={locked} onClick={() => void act(`Starting ${row.id}`, () => post(`/api/plugins/${row.id}/start`))}><PlayIcon /> Start</Button>
                            )}
                            <NativeSelect
                              size="sm"
                              aria-label={`Active version of ${row.name}`}
                              title="Active version: which checkout the plugin runs from"
                              disabled={locked}
                              value={row.activeVersion?.type === 'worktree' && (worktrees[row.project] || []).includes(row.activeVersion.name) ? `worktree:${row.activeVersion.name}` : 'main'}
                              onChange={(e) => {
                                const v = e.target.value;
                                const body = v === 'main' ? { type: 'main' } : { type: 'worktree', name: v.slice('worktree:'.length) };
                                void act(`Switching ${row.id} to ${v}`, () => post(`/api/plugins/${row.id}/version`, body), { action: 'version', ids: [row.id] });
                              }}
                            >
                              <option value="main">main</option>
                              {(worktrees[row.project] || []).map((w) => <option key={w} value={`worktree:${w}`}>worktree {w}</option>)}
                            </NativeSelect>
                          </>
                        )}
                        <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={locked} onClick={() => void act(`Disabling ${row.id}`, () => post(`/api/plugins/${row.id}/disable`))}>Disable</Button>
                      </>
                    )}
                  </div>
                )}
                {row.enabled && localOnly.length > 0 && (
                  <div className="mt-2 text-xs text-warning" title="These plugin capabilities run only on the machine code-conductor runs on" data-local-only>
                    on system '{row.system}': {localOnly.join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Plugin Library"
        description="Plugins you can clone into your projects root. Once installed, a plugin appears above (rescan if needed); enable it there."
        action={
          <Button variant="outline" size="sm" disabled={!updatable || locked} onClick={() => void updateAll()} title="Update every installed library plugin that is behind its origin, one at a time">
            {updatingAll ?? (updatable ? `Update all (${updatable})` : 'Update all')}
          </Button>
        }
      >
        <Status text={libStatus?.text} tone={libStatus?.error ? 'error' : 'muted'} />
        <div className="grid gap-3 lg:grid-cols-2" data-testid="library-list">
          {(library || []).map((e) => (
            <div key={e.id} data-entry={e.id} className={cn('flex min-w-0 flex-col rounded-xl border px-4 py-3', e.installed && 'bg-muted/30')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.name}</span>
                {e.installed && <Badge variant="success">installed</Badge>}
              </div>
              {e.description && <p className="mt-1 text-sm text-muted-foreground">{e.description}</p>}
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{e.repo}</div>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                {busyEntry?.id === e.id ? (
                  <Button size="sm" disabled><LoaderCircleIcon className="animate-spin" /> {busyEntry.label}</Button>
                ) : e.installed ? (
                  <>
                    <span className="text-xs text-muted-foreground">installed as {e.installedAs}{!e.updateAvailable && ' · up to date'}</span>
                    {e.updateAvailable && <Button size="sm" disabled={locked} onClick={() => void update(e)}><RefreshCwIcon /> Update</Button>}
                  </>
                ) : (
                  <Button size="sm" disabled={locked} onClick={() => void install(e)}><DownloadIcon /> Install</Button>
                )}
              </div>
              <LogBox text={live[e.id] ?? ''} className="mt-2 max-h-40" />
            </div>
          ))}
        </div>
        {libTail && (
          <details open className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">Install output</summary><LogBox text={libTail} className="rounded-none" /></details>
        )}
      </SettingsCard>
    </div>
  );
}
