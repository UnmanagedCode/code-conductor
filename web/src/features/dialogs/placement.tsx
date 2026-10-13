// Where a project's tree lives: this machine, or a registered system and one of
// its targets ("remote"). Shared by the New-project and Add-project dialogs.
// Systems come from GET /api/settings/systems (only rows with a provider
// command are offered); a system's targets from GET /api/systems/:id/remotes.
// A system that lists targets gets a dropdown plus "Other…"; one that doesn't,
// or whose listing failed, gets a free-text field.
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { capabilities, loadCapabilities } from '@shared/capabilities';
import { apiFetch } from '@shared/http';

export const REMOTE_OTHER = '__other__';
const REMOTE_NONE = '__none__';

type SystemRow = { id: string; label: string; managed?: boolean; launch?: string[] };

export type PlacementState = ReturnType<typeof usePlacement>;

export function usePlacement() {
  // null until the capabilities are known: no System row is offered before then.
  const [enabled, setEnabled] = React.useState<boolean | null>(() => {
    const c = capabilities();
    return c ? !!c.remoteSystems : null;
  });
  const [systems, setSystems] = React.useState<{ id: string; label: string }[]>([{ id: 'local', label: 'This machine' }]);
  const [systemsNote, setSystemsNote] = React.useState('');
  const [system, setSystemValue] = React.useState('local');
  const [remoteMode, setRemoteMode] = React.useState<'free' | 'select'>('free');
  const [remoteIds, setRemoteIds] = React.useState<string[]>([]);
  const [remoteSelect, setRemoteSelectValue] = React.useState('');
  const [remoteText, setRemoteText] = React.useState('');
  const [remoteNote, setRemoteNote] = React.useState('');
  const remoteSeq = React.useRef(0);
  const systemRef = React.useRef(system);
  systemRef.current = system;

  const chosenSystem = system && system !== 'local' ? system : null;
  const chosenRemote = remoteMode === 'select' && remoteSelect !== REMOTE_OTHER
    ? remoteSelect || null
    : remoteText.trim() || null;

  const loadSystems = React.useCallback(async () => {
    const caps = await loadCapabilities();
    if (caps && !caps.remoteSystems) { setEnabled(false); return; }
    setEnabled(true);
    let rows: SystemRow[] = [{ id: 'local', label: 'This machine', managed: true }];
    let note = '';
    try {
      rows = (await apiFetch<{ systems?: SystemRow[] } | null>('/api/settings/systems'))?.systems ?? rows;
    } catch (e: any) {
      note = `Could not read the systems registry (${e.message}). Only this machine is offered.`;
    }
    setSystems(rows
      .filter((s) => s.managed || (Array.isArray(s.launch) && s.launch.length))
      .map((s) => ({ id: s.id, label: s.managed ? s.label : `${s.label} (${s.id})` })));
    setSystemsNote(note);
  }, []);

  async function loadRemotes(sys: string) {
    const mine = ++remoteSeq.current;
    setRemoteMode('free');
    setRemoteNote(`Listing the targets system '${sys}' is configured for…`);
    let answer: any;
    try {
      answer = await apiFetch(`/api/systems/${encodeURIComponent(sys)}/remotes`);
    } catch (e: any) {
      answer = { state: 'failed', reason: e.message };
    }
    if (mine !== remoteSeq.current || systemRef.current !== sys) return;
    if (answer?.state === 'listed') {
      const ids: string[] = answer.remoteIds ?? [];
      setRemoteIds(ids);
      setRemoteMode('select');
      setRemoteSelectValue(remoteTextRef.current.trim() ? REMOTE_OTHER : '');
      setRemoteNote(ids.length ? '' : `System '${sys}' lists no configured targets right now. Choose Other… to type one.`);
    } else if (answer?.state === 'failed') {
      setRemoteNote(`Could not list the targets of system '${sys}' (${answer.reason}). Type one.`);
    } else {
      setRemoteNote('');
    }
  }
  const remoteTextRef = React.useRef(remoteText);
  remoteTextRef.current = remoteText;

  function setSystem(next: string) {
    setSystemValue(next);
    systemRef.current = next;
    remoteSeq.current++;
    setRemoteMode('free');
    setRemoteIds([]);
    setRemoteSelectValue('');
    setRemoteText('');
    setRemoteNote('');
    if (next && next !== 'local') void loadRemotes(next);
  }

  /** Validation of the target choice when the system lists targets. */
  function remoteError(): string | null {
    if (!chosenSystem || remoteMode !== 'select') return null;
    if (remoteSelect === '') return `Choose a target on '${chosenSystem}'. It lists the targets it is configured for.`;
    if (remoteSelect === REMOTE_OTHER && !remoteText.trim()) return `Type a target for '${chosenSystem}', or pick a listed one.`;
    return null;
  }

  const describe = () =>
    chosenRemote ? `target '${chosenRemote}' of system '${chosenSystem}'` : `system '${chosenSystem}'`;

  return {
    enabled, systems, systemsNote, system, setSystem, loadSystems,
    remoteMode, remoteIds, remoteSelect, setRemoteSelect: setRemoteSelectValue, remoteText, setRemoteText, remoteNote,
    chosenSystem, chosenRemote, remoteError, describe,
    /** Changes whenever the placement moves (path-picker cache key). */
    key: `${chosenSystem ?? 'local'}\n${chosenRemote ?? ''}`,
  };
}

export function PlacementFields({ p, idPrefix }: { p: PlacementState; idPrefix: string }) {
  if (p.enabled !== true) return null;
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-system`}>System</Label>
        <Select value={p.system} onValueChange={p.setSystem}>
          <SelectTrigger id={`${idPrefix}-system`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {p.systems.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {p.systemsNote && <p className="text-xs text-muted-foreground">{p.systemsNote}</p>}
      </div>
      {p.chosenSystem && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-remote`}>Target</Label>
          {p.remoteMode === 'select' && (
            <Select value={p.remoteSelect || REMOTE_NONE} onValueChange={(v) => p.setRemoteSelect(v === REMOTE_NONE ? '' : v)}>
              <SelectTrigger id={`${idPrefix}-remote-select`} className="w-full" aria-label="Target"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={REMOTE_NONE}>Choose a target…</SelectItem>
                {p.remoteIds.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                <SelectItem value={REMOTE_OTHER}>Other…</SelectItem>
              </SelectContent>
            </Select>
          )}
          {(p.remoteMode === 'free' || p.remoteSelect === REMOTE_OTHER) && (
            <Input
              id={`${idPrefix}-remote`}
              value={p.remoteText}
              onChange={(e) => p.setRemoteText(e.target.value)}
              autoFocus={p.remoteMode === 'select'}
              placeholder="Container, host or VM id; blank for the system's default"
            />
          )}
          {p.remoteNote && <p className="text-xs text-muted-foreground">{p.remoteNote}</p>}
        </div>
      )}
    </>
  );
}
