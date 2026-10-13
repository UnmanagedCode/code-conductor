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

type Line = { text: string; error?: boolean } | null;
type ProjectWorktrees = { name: string; worktrees?: { worktreeName?: string }[] };
type PluginsState = {
  rows: PluginRow[] | null;
  worktrees: Record<string, string[]>;
  library: LibraryEntry[] | null;
  /** Each status line as the last load left it. */
  loaded: Line;
  libLoaded: Line;
  /** An action's progress, warning or refusal; shown over the load's line until the next reload that resets. */
  note: Line;
  libNote: Line;
  libTail: string;
  live: Record<string, string>;
  /** The one-action-at-a-time guard. */
  busy: boolean;
  busyEntry: { id: string; label: string } | null;
  updatingAll: string | null;
};
const PLUGINS0: PluginsState = {
  rows: null, worktrees: {}, library: null, loaded: { text: 'Loading…' }, libLoaded: { text: 'Loading…' },
  note: null, libNote: null, libTail: '', live: {}, busy: false, busyEntry: null, updatingAll: null,
};

// The section's lists, status lines, output and running action live at module
// scope, not in the component: Settings remounts a section on every switch and
// on re-entry, and an action still running then must keep every other action
// locked and land its outcome in the section shown.
export const pluginsStore = createStore<PluginsState>(PLUGINS0);

/** Takes the one-action-at-a-time guard; false while another action holds it. */
function claim(): boolean {
  if (pluginsStore.get().busy) return false;
  pluginsStore.set({ busy: true });
  return true;
}

/**
 * Reloads both lists and the load-owned status lines. `reset` also drops both
 * action notes and every live log; a remount's load keeps them.
 */
async function loadPlugins(reset: boolean): Promise<PluginRow[] | null> {
  try {
    const [plugins, projects, lib] = await Promise.all([
      json<{ rows: PluginRow[]; notices?: { file: string; reason: string; backup?: string }[] }>('/api/plugins'),
      json<ProjectWorktrees[]>('/api/projects').catch((): ProjectWorktrees[] => []),
      json<{ entries: LibraryEntry[]; skipped?: { dir: string; file: string | null; reason: string }[] }>('/api/plugins/library'),
    ]);
    const worktrees: Record<string, string[]> = {};
    for (const p of projects) worktrees[p.name] = (p.worktrees || []).map((w) => w.worktreeName).filter((n): n is string => !!n);
    const loaded: Line = plugins.notices?.length
      ? { error: true, text: plugins.notices.map((n) => `${n.file} was unreadable (${n.reason})${n.backup ? ` — moved aside to ${n.backup}; plugin enable/version state was reset` : ''}`).join(' · ') }
      : { text: plugins.rows.length ? `${plugins.rows.length} plugin${plugins.rows.length === 1 ? '' : 's'}` : 'No plugins found. A plugin is a project with a conductor.plugin.json at its root.' };
    const libLoaded: Line = lib.skipped?.length
      ? { error: true, text: `Skipped ${lib.skipped.length} library drop-in(s): ${lib.skipped.map((s) => (s.file === null ? `${s.dir} (${s.reason})` : `${s.dir}/${s.file} (${s.reason})`)).join(', ')}` }
      : { text: lib.entries.length ? `${lib.entries.length} available` : 'No library entries.' };
    pluginsStore.set({ rows: plugins.rows, worktrees, library: lib.entries, loaded, libLoaded, ...(reset ? { note: null, libNote: null, live: {} } : {}) });
    return plugins.rows;
  } catch (e) {
    pluginsStore.set({ loaded: { error: true, text: `Failed to load plugins: ${errText(e)}` } });
    return null;
  }
}

/**
 * Opening Settings drops the action notes and live logs. While an action is
 * running it keeps them, so its progress line and log stay on screen, as About's
 * running update does.
 */
export function resetPluginNotes() {
  if (!pluginsStore.get().busy) pluginsStore.set({ note: null, libNote: null, live: {} });
}

const appendLive = (id: string) => (text: string) => pluginsStore.set((s) => ({ live: { ...s.live, [id]: capLog(s.live[id] ?? '', text) } }));

async function act(label: string, fn: () => Promise<unknown>, change?: PluginsChange) {
  if (!claim()) return;
  pluginsStore.set({ note: { text: `${label}…` } });
  try {
    await fn();
    await loadPlugins(true);
    // A failed reload leaves its own message on the line, never the progress note.
    pluginsStore.set({ note: null });
    notifyPluginsChanged(change);
  } catch (e) {
    pluginsStore.set({ note: { error: true, text: `${label} failed: ${errText(e)}` } });
  } finally {
    pluginsStore.set({ busy: false });
  }
}

async function install(entry: LibraryEntry) {
  if (!claim()) return;
  pluginsStore.set({ busyEntry: { id: entry.id, label: 'Installing…' }, libNote: { text: `Installing ${entry.name}…` }, libTail: '' });
  try {
    const result = await streamAction(`/api/plugins/library/${entry.id}/install`, appendLive(entry.id));
    await loadPlugins(true);
    notifyPluginsChanged(undefined);
    const w = hookWarning(entry.name, 'Installed', 'post-install', result?.postClone);
    pluginsStore.set(w ? { libNote: { error: true, text: w.text }, libTail: w.tail ?? '' } : { libNote: null });
  } catch (e) {
    const tail = (e as HttpError).tail;
    pluginsStore.set({ libNote: { error: true, text: `Installing ${entry.name} failed: ${errText(e)}` }, ...(tail ? { libTail: tail } : {}) });
  } finally {
    pluginsStore.set({ busyEntry: null, busy: false });
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
  if (!claim()) return;
  pluginsStore.set({ busyEntry: { id: entry.id, label: 'Updating…' }, libNote: { text: `Updating ${entry.name}…` }, libTail: '' });
  try {
    const out = await runUpdate(entry);
    if (out.ok) {
      const fresh = (await loadPlugins(true)) ?? pluginsStore.get().rows ?? [];
      notifyPluginsChanged(updateChange([out.result], fresh));
      const w = updateWarning(entry.name, out.result);
      pluginsStore.set(w ? { libNote: { error: true, text: w.text }, libTail: w.tail ?? '' } : { libNote: null });
    } else {
      pluginsStore.set({ libNote: { error: true, text: `Updating ${entry.name} failed: ${out.error}` }, ...(out.tail ? { libTail: out.tail } : {}) });
    }
  } finally {
    pluginsStore.set({ busyEntry: null, busy: false });
  }
}

async function updateAll() {
  const targets = (pluginsStore.get().library || []).filter((e) => e.installed && e.updateAvailable);
  if (!targets.length || !claim()) return;
  pluginsStore.set({ libTail: '' });
  const outcomes: ({ name: string } & Awaited<ReturnType<typeof runUpdate>>)[] = [];
  try {
    for (const [i, entry] of targets.entries()) {
      pluginsStore.set({
        updatingAll: `Updating ${i + 1}/${targets.length}…`,
        busyEntry: { id: entry.id, label: 'Updating…' },
        libNote: { text: `Updating ${entry.name} (${i + 1}/${targets.length})…` },
      });
      outcomes.push({ name: entry.name, ...(await runUpdate(entry)) });
    }
    pluginsStore.set({ busyEntry: null });
    const fresh = (await loadPlugins(true)) ?? pluginsStore.get().rows ?? [];
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
    const tails = problems.filter((p) => p.tail);
    pluginsStore.set({
      libNote: {
        error: problems.length > 0,
        text: `Updated ${ok.length} of ${targets.length} plugin${targets.length === 1 ? '' : 's'}${problems.length ? ` — ${problems.map((p) => p.text).join('; ')}` : ''}`,
      },
      ...(tails.length ? { libTail: tails.map((p) => `── ${p.name} ──\n${p.tail}`).join('\n\n') } : {}),
    });
  } finally {
    pluginsStore.set({ updatingAll: null, busyEntry: null, busy: false });
  }
}

export function PluginsSection() {
  const { rows, worktrees, library, loaded, libLoaded, note, libNote, libTail, live, busyEntry, updatingAll } = useStore(pluginsStore, (s) => s);
  React.useEffect(() => { void loadPlugins(false); }, []);
  const status = note ?? loaded;
  const libStatus = libNote ?? libLoaded;
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
              <div key={row.id} data-plugin={row.id} className="min-w-0 rounded-xl border px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <PlugIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 font-medium break-words">{row.name}</span>
                  <Badge variant={STATE_VARIANT[row.state] ?? 'secondary'}>{row.state}</Badge>
                </div>
                <div className="mt-1 text-xs break-words text-muted-foreground">{metaBits(row).join(' · ')}</div>
                {contribs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">{contribs.map((c) => <Badge key={c} variant="outline" className="font-normal">{c}</Badge>)}</div>
                )}
                {!!row.conventions?.length && (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {row.conventions.map((c) => (
                      <li key={c.name} className="break-words"><span className="font-medium">{c.hasScaffold ? `${c.name} · scaffolds` : c.name}</span> <span className="text-muted-foreground">{c.description}</span></li>
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
        <div className="grid gap-3 @3xl:grid-cols-2" data-testid="library-list">
          {(library || []).map((e) => (
            <div key={e.id} data-entry={e.id} className={cn('flex min-w-0 flex-col rounded-xl border px-4 py-3', e.installed && 'bg-muted/30')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 font-medium break-words">{e.name}</span>
                {e.installed && <Badge variant="success">installed</Badge>}
              </div>
              {e.description && <p className="mt-1 text-sm break-words text-muted-foreground">{e.description}</p>}
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={e.repo}>{e.repo}</div>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                {busyEntry?.id === e.id ? (
                  <Button size="sm" disabled><LoaderCircleIcon className="animate-spin" /> {busyEntry.label}</Button>
                ) : e.installed ? (
                  <>
                    <span className="min-w-0 text-xs break-words text-muted-foreground">installed as {e.installedAs}{!e.updateAvailable && ' · up to date'}</span>
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
