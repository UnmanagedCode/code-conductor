import * as React from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createStore, useStore } from '@/state/createStore';
import { SettingsCard, Status, LogBox, type StatusLine } from './ui';
import { ApiError } from '@shared/http';
import { json, errText, streamAction, capLog } from './api';

/** `GET /api/settings/claude-update`: the `--version` probe of the CLI sessions launch with. */
export type ClaudeBinProbe = { found: boolean; command: string; version?: string; error?: string; message?: string; stderr?: string; exitCode?: number | null };

/** The card's version line, or why the CLI cannot run. */
export function describeClaude(p: ClaudeBinProbe): StatusLine {
  if (p.found) return { text: p.version ? `v${p.version}` : 'version unknown' };
  return { text: `can't run ${p.command}: ${p.message || p.stderr || p.error || 'unknown error'}`, tone: 'error' };
}

const CHECKING: StatusLine = { text: 'Checking Claude Code version…' };

// The running Claude update lives at module scope, not in the card: it keeps
// streaming after About is left, and a remounted card must show it and offer
// no second Update.
export const claudeUpdateStore = createStore<{ line: StatusLine; updating: boolean; log: string }>({
  line: CHECKING, updating: false, log: '',
});

export function ClaudeUpdateCard() {
  const { line, updating, log } = useStore(claudeUpdateStore, (s) => s);

  React.useEffect(() => {
    if (claudeUpdateStore.get().updating) return;
    claudeUpdateStore.set({ line: CHECKING, log: '' });
    json<ClaudeBinProbe>('/api/settings/claude-update')
      .then((p) => claudeUpdateStore.set({ line: describeClaude(p) }))
      .catch((e) => claudeUpdateStore.set({ line: { text: `Failed to check the Claude Code version: ${errText(e)}`, tone: 'error' } }));
  }, []);

  async function update() {
    if (claudeUpdateStore.get().updating) return;
    claudeUpdateStore.set({ updating: true, line: { text: 'Updating Claude Code…' }, log: '' });
    try {
      const result = await streamAction('/api/settings/claude-update', (t) => claudeUpdateStore.set({ log: capLog(claudeUpdateStore.get().log, t) }));
      const version = result?.version ? `v${result.version}` : '(version unknown)';
      claudeUpdateStore.set({
        line: { text: `Claude Code ${version} · update finished. Running sessions keep the CLI they started with; new sessions use this one.`, tone: 'ok' },
        updating: false,
      });
    } catch (e) {
      claudeUpdateStore.set({ line: { text: `Claude Code update failed: ${errText(e)}`, tone: 'error' } });
      if (e instanceof ApiError && e.tail) claudeUpdateStore.set({ log: e.tail });
      claudeUpdateStore.set({ updating: false });
    }
  }

  return (
    <SettingsCard
      title="Claude Code"
      description={<>Runs <code>claude update</code> on the CLI cc launches sessions with.</>}
      action={<Button size="sm" disabled={updating} onClick={() => void update()}><RefreshCwIcon className={updating ? 'animate-spin' : undefined} /> {updating ? 'Updating…' : 'Update'}</Button>}
    >
      <Status text={line.text} tone={line.tone ?? 'muted'} />
      <LogBox text={log} />
    </SettingsCard>
  );
}
