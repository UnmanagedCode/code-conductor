import * as React from 'react';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OctopusBadge } from '@/components/mascot/Octopus';
import { performRestart } from '@/features/sidebar/restart';
import { createStore, useStore } from '@/state/createStore';
import { SettingsCard, Status, LogBox } from './ui';
import { json, errText, streamAction, capLog, HttpError } from './api';

export type SelfUpdateStatus = { version?: string; upstream?: string | null; ahead?: number | null; behind?: number | null; canCheck?: boolean; diverged?: boolean; updateAvailable?: boolean };

/** The version line and whether an Update button is offered. */
export function describeUpdate(d: SelfUpdateStatus): { text: string; canUpdate: boolean } {
  const v = d.version ? `v${d.version}` : 'version unknown';
  if (!d.canCheck) return { text: `${v} · can't check for updates (no upstream branch)`, canUpdate: false };
  if (d.diverged) return { text: `${v} · ${d.ahead} ahead, ${d.behind} behind ${d.upstream}; can't fast-forward`, canUpdate: false };
  if (d.updateAvailable) {
    const n = d.behind ?? 0;
    return { text: `${v} · update available (${n} commit${n === 1 ? '' : 's'}${d.upstream ? ` behind ${d.upstream}` : ''})`, canUpdate: true };
  }
  return { text: `${v} · up to date`, canUpdate: false };
}

type Line = { text: string; tone?: 'error' | 'ok' | 'muted' };

// The running self-update lives at module scope, not in the section: the pull
// keeps streaming after About is left, and a remounted section must show it and
// offer no second Update.
export const selfUpdateStore = createStore<{ line: Line; canUpdate: boolean; updating: boolean; label: string; log: string }>({
  line: { text: 'Checking for updates…' }, canUpdate: false, updating: false, label: 'Update', log: '',
});

export function AboutSection() {
  const { line, canUpdate, updating, label, log } = useStore(selfUpdateStore, (s) => s);

  React.useEffect(() => {
    if (selfUpdateStore.get().updating) return;
    selfUpdateStore.set({ line: { text: 'Checking for updates…' }, canUpdate: false, label: 'Update', log: '' });
    json<SelfUpdateStatus>('/api/settings/self-update')
      .then((d) => { const r = describeUpdate(d); selfUpdateStore.set({ line: { text: r.text }, canUpdate: r.canUpdate }); })
      .catch((e) => selfUpdateStore.set({ line: { text: `Failed to check for updates: ${errText(e)}`, tone: 'error' } }));
  }, []);

  async function update() {
    if (selfUpdateStore.get().updating) return;
    selfUpdateStore.set({ updating: true, label: 'Updating…', line: { text: 'Updating conductor…' }, log: '' });
    try {
      const result = await streamAction('/api/settings/self-update', (t) => selfUpdateStore.set({ log: capLog(selfUpdateStore.get().log, t) }));
      if (result?.npm && !result.npm.ok) {
        // A refusal (a linked node_modules) never ran npm: its own message says what to do.
        const text = result.npm.ran === false && result.npm.error
          ? `The update was pulled but its dependencies were not installed: ${result.npm.error}`
          : 'The update was pulled but npm install failed. Resolve it before restarting.';
        selfUpdateStore.set({ line: { text, tone: 'error' } });
        if (result.npm.tail) selfUpdateStore.set({ log: result.npm.tail });
        selfUpdateStore.set({ label: 'Retry', updating: false });
        return;
      }
      selfUpdateStore.set({ line: { text: 'Update applied. Restarting…', tone: 'ok' } });
      const restart = await performRestart({ resume: true });
      if (!restart.ok) {
        // The pull landed but this process keeps serving the version it booted.
        selfUpdateStore.set({
          line: { text: `Updated, but the restart was refused: ${restart.error}. cc is still running the previous version; fix it and restart.`, tone: 'error' },
          updating: false, canUpdate: false, label: 'Update',
        });
        if (restart.tail) selfUpdateStore.set({ log: restart.tail });
      }
    } catch (e) {
      selfUpdateStore.set({ line: { text: `Update failed: ${errText(e)}`, tone: 'error' } });
      if ((e as HttpError).tail) selfUpdateStore.set({ log: (e as HttpError).tail! });
      selfUpdateStore.set({ label: 'Update', updating: false });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <OctopusBadge className="size-16 shrink-0" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Code Conductor</h2>
          <p className="text-sm text-muted-foreground">Orchestrate multiple Claude Code CLI instances across projects from one browser tab.</p>
        </div>
      </div>
      <SettingsCard
        title="Version"
        action={canUpdate && <Button size="sm" disabled={updating} onClick={() => void update()}><RefreshCwIcon className={updating ? 'animate-spin' : undefined} /> {label}</Button>}
      >
        <Status text={line.text} tone={line.tone ?? 'muted'} />
        <LogBox text={log} />
      </SettingsCard>
      <SettingsCard title="License">
        <div className="max-w-[70ch] space-y-3 text-sm leading-relaxed text-muted-foreground" data-testid="legal-notice">
          <p>Copyright © 2026 UnmanagedCode.</p>
          <p>
            Licensed under the{' '}
            <a className="font-medium text-primary hover:underline" href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">GNU Affero General Public License v3.0 (AGPL-3.0)</a>.
          </p>
          <p>
            Source code:{' '}
            <a className="inline-flex max-w-full items-center gap-1 font-medium break-all text-primary hover:underline" href="https://github.com/UnmanagedCode/code-conductor" target="_blank" rel="noopener noreferrer">
              github.com/UnmanagedCode/code-conductor <ExternalLinkIcon className="size-3.5" />
            </a>
          </p>
          <p>This program is free software: you may redistribute and/or modify it under the terms of the AGPL-3.0. If you run a modified version on a network server, §13 requires you to offer its users access to the corresponding source.</p>
        </div>
      </SettingsCard>
    </div>
  );
}
