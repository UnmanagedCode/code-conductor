// New session in a project: capability tier, Plan/Code, and advanced options
// (effort, thinking, worktree, temp, debug). Sends a `tier` — never a model or
// backend — so the server resolves the tier's binding at spawn time. A
// postWorktreeCreate hook's result is shown in place after a successful spawn.
import * as React from 'react';
import { ChevronRightIcon, GitBranchIcon, LoaderCircleIcon, SparklesIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSignal, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { apiFetch } from '@/lib/core/http.js';
import {
  backendIdOf, CLAUDE_BACKEND, getActiveDefaultSpawnTier, getActiveTierBackend, getActiveTierEffort, getActiveTierEnabled,
  getEffortLevels, getTierLabel, getTierList, getVersionLabel,
} from '@/lib/core/models.js';
import { modelsSignal } from '@/app/models';
import { refreshInstances, refreshProjects, selectInstance } from '@/app/controller';
import { beginGesture, gestureOvertaken } from '@/app/gestures';
import { cn } from '@/lib/utils';
import { closeDialog, dialogStore } from './api';
import { FormError } from './FormError';
import { useOpenKey } from './useOpenKey';

const DEFAULT_EFFORT = '__default__';

/** The tier a new session starts on: the default spawn tier if enabled, else the first enabled one. */
export function defaultSpawnTier(): string {
  const d = getActiveDefaultSpawnTier();
  if (getActiveTierEnabled(d)) return d;
  for (const t of ['balanced', 'fast', 'powerful', 'frontier']) if (getActiveTierEnabled(t)) return t;
  return 'balanced';
}

/** Tiers offered: the enabled ones; when every tier is off, the fallback tier alone. */
export function visibleTiers(): string[] {
  const tiers = getTierList() as string[];
  const on = tiers.filter((t) => getActiveTierEnabled(t));
  return on.length ? on : [defaultSpawnTier()];
}

function tierSublabel(tier: string) {
  const b = getActiveTierBackend(tier);
  return backendIdOf(b) !== CLAUDE_BACKEND ? b.model : getVersionLabel(b.model);
}

type Hook = { ran: boolean; timedOut?: boolean; exitCode?: number; durationMs?: number; truncated?: boolean; output?: string };

function SpawnBody({ project, worktreeIntent }: { project: string; worktreeIntent: string | null }) {
  useSignal(modelsSignal);
  const proj = useStore(appStore, (s) => s.projects.find((p) => p.name === project));
  const [tier, setTier] = React.useState(defaultSpawnTier);
  const [mode, setMode] = React.useState<'bypassPermissions' | 'plan'>('bypassPermissions');
  const [effort, setEffort] = React.useState(DEFAULT_EFFORT);
  const [thinking, setThinking] = React.useState('adaptive');
  const [worktree, setWorktree] = React.useState(!!worktreeIntent);
  const [temp, setTemp] = React.useState(!worktreeIntent);
  const [debug, setDebug] = React.useState(false);
  const debugTouched = React.useRef(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [hook, setHook] = React.useState<Hook | null>(null);

  const tiers = visibleTiers();
  // A tier disabled in Settings while the dialog is open falls back to the default.
  React.useEffect(() => {
    if (!getActiveTierEnabled(tier)) setTier(defaultSpawnTier());
  });

  React.useEffect(() => {
    let live = true;
    fetch('/api/settings/spawn', { cache: 'no-store' })
      .then((r) => r.json())
      // A tick made before the default arrives is the user's answer; the late default must not overwrite it.
      .then((d) => { if (live && !debugTouched.current) setDebug(!!d.debugByDefault); })
      .catch(() => { /* leave unchecked */ });
    return () => { live = false; };
  }, []);

  const isGit = !!proj?.isGitRepo;
  const unborn = !!proj?.unbornHead;
  const worktreeHint = worktreeIntent
    ? `Spawns into the existing worktree ${worktreeIntent}.`
    : !isGit ? 'The project is not a git repo. Run git init first to use worktrees.'
    : unborn ? 'The project has no commits yet. Make a first commit to use worktrees.'
    : 'Creates a sibling worktree branched off the current HEAD.';

  async function spawn() {
    if (busy || hook) return;
    const gesture = beginGesture();
    setBusy(true);
    setError('');
    const body = {
      project,
      mode,
      effort: effort === DEFAULT_EFFORT ? undefined : effort,
      tier,
      thinking,
      worktree: worktreeIntent ? worktreeIntent : worktree ? true : undefined,
      temp: temp || undefined,
      debug,
      autoApprovePlan: mode === 'plan' || undefined,
    };
    try {
      const inst = await apiFetch('/api/instances', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      await refreshProjects();
      await refreshInstances();
      if (!gestureOvertaken(gesture)) selectInstance(inst.id, { userGesture: true, gesture });
      const h: Hook | undefined = inst.worktree?.postWorktreeCreate;
      if (h?.ran) setHook(h);
      else closeDialog('spawn');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const hookLabel = hook && `${hook.timedOut ? 'timed out' : hook.exitCode === 0 ? 'exit 0' : `exit ${hook.exitCode}`}${hook.durationMs != null ? ` (${hook.durationMs}ms)` : ''}${hook.truncated ? ' · output truncated' : ''}`;

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => { e.preventDefault(); void spawn(); }}
    >
      <DialogHeader>
        <DialogTitle>New session</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5">
          in <span className="font-medium text-foreground">{project}</span>
          {worktreeIntent && <span className="flex items-center gap-1 font-mono text-xs"><GitBranchIcon className="size-3" />{worktreeIntent}</span>}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label>Model</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Capability tier">
          {tiers.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={t === tier}
              data-tier={t}
              onClick={() => setTier(t)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
                t === tier ? 'border-primary bg-primary/8 ring-1 ring-primary/30' : 'hover:border-foreground/20 hover:bg-muted/50',
              )}
            >
              <span className="text-sm font-medium">{getTierLabel(t)}</span>
              <span className="truncate text-xs text-muted-foreground">{tierSublabel(t)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Mode</Label>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Spawn mode">
          {([
            ['plan', 'Plan & approve', 'Proposes a plan you approve first'],
            ['bypassPermissions', 'Code', 'Writes code and runs commands right away'],
          ] as const).map(([m, label, hint]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-mode={m}
              onClick={() => setMode(m)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
                mode === m ? (m === 'plan' ? 'border-plan bg-plan/8 ring-1 ring-plan/30' : 'border-primary bg-primary/8 ring-1 ring-primary/30') : 'hover:border-foreground/20 hover:bg-muted/50',
              )}
            >
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
      </div>

      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger className="group/adv flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]/adv:rotate-90" /> Advanced options
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 grid gap-4 rounded-xl border bg-muted/30 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="sd-effort">Effort</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger id="sd-effort" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_EFFORT}>Default ({getActiveTierEffort(tier)})</SelectItem>
                  {(getEffortLevels() as string[]).map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sd-thinking">Thinking</Label>
              <Select value={thinking} onValueChange={setThinking}>
                <SelectTrigger id="sd-thinking" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="adaptive">Adaptive (Claude decides)</SelectItem>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <CheckRow id="sd-worktree" checked={worktree} disabled={!!worktreeIntent || !isGit || unborn} onChange={setWorktree} label="Run in an isolated git worktree" hint={worktreeHint} />
          <CheckRow id="sd-temp" checked={temp} onChange={setTemp} label="Temp session" hint="The transcript is removed when the session ends." />
          <CheckRow id="sd-debug" checked={debug} onChange={(v) => { debugTouched.current = true; setDebug(v); }} label="Debug mode" hint={<>Captures stdin, stdout and stderr to <code className="font-mono">&lt;cwd&gt;/.code-conductor/debug/&lt;instance-id&gt;/</code></>} />
        </CollapsibleContent>
      </Collapsible>

      <FormError>{error}</FormError>

      {hook && (
        <Collapsible defaultOpen={hook.exitCode !== 0 || !!hook.timedOut} className="rounded-xl border">
          <CollapsibleTrigger className={cn('group/hook flex w-full items-center gap-2 px-3 py-2 text-left text-sm', hook.exitCode === 0 && !hook.timedOut ? 'text-success' : 'text-warning')}>
            <TerminalIcon className="size-4" /> Worktree hook: {hookLabel}
            <ChevronRightIcon className="ml-auto size-4 transition-transform group-data-[state=open]/hook:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="max-h-60 overflow-auto border-t bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap" data-hook-output>{hook.output || ''}</pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      <DialogFooter>
        {hook ? (
          <Button type="button" onClick={() => closeDialog('spawn')}>Done</Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={() => closeDialog('spawn')}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />} Start session
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}

export function CheckRow({ id, checked, onChange, label, hint, disabled }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className={cn('font-normal', disabled && 'opacity-60')}>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function SpawnDialog() {
  const slot = useStore(dialogStore, (s) => s.spawn);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('spawn'); }}>
      {slot && (
        <DialogContent className="sm:max-w-xl" data-dialog="spawn">
          <SpawnBody key={key} project={slot.project} worktreeIntent={slot.opts.worktree ?? null} />
        </DialogContent>
      )}
    </Dialog>
  );
}
