import * as React from 'react';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OctopusBadge } from '@/components/mascot/Octopus';
import { performRestart } from '@/features/sidebar/restart';
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

export function AboutSection() {
  const [line, setLine] = React.useState<{ text: string; tone?: 'error' | 'ok' | 'muted' }>({ text: 'Checking for updates…' });
  const [canUpdate, setCanUpdate] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);
  const [label, setLabel] = React.useState('Update');
  const [log, setLog] = React.useState('');

  React.useEffect(() => {
    json<SelfUpdateStatus>('/api/settings/self-update')
      .then((d) => { const r = describeUpdate(d); setLine({ text: r.text }); setCanUpdate(r.canUpdate); })
      .catch((e) => setLine({ text: `Failed to check for updates: ${errText(e)}`, tone: 'error' }));
  }, []);

  async function update() {
    if (updating) return;
    setUpdating(true);
    setLabel('Updating…');
    setLine({ text: 'Updating conductor…' });
    setLog('');
    try {
      const result = await streamAction('/api/settings/self-update', (t) => setLog((l) => capLog(l, t)));
      if (result?.npm && !result.npm.ok) {
        setLine({ text: 'The update was pulled but npm install failed. Resolve it before restarting.', tone: 'error' });
        if (result.npm.tail) setLog(result.npm.tail);
        setLabel('Retry');
        setUpdating(false);
        return;
      }
      setLine({ text: 'Update applied. Restarting…', tone: 'ok' });
      void performRestart({ resume: true });
    } catch (e) {
      setLine({ text: `Update failed: ${errText(e)}`, tone: 'error' });
      if ((e as HttpError).tail) setLog((e as HttpError).tail!);
      setLabel('Update');
      setUpdating(false);
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
            <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href="https://github.com/UnmanagedCode/code-conductor" target="_blank" rel="noopener noreferrer">
              github.com/UnmanagedCode/code-conductor <ExternalLinkIcon className="size-3.5" />
            </a>
          </p>
          <p>This program is free software: you may redistribute and/or modify it under the terms of the AGPL-3.0. If you run a modified version on a network server, §13 requires you to offer its users access to the corresponding source.</p>
        </div>
      </SettingsCard>
    </div>
  );
}
