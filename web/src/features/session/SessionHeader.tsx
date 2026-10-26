import * as React from 'react';
import {
  BarChart3Icon, BellIcon, BellOffIcon, BrainIcon, BugIcon, CheckIcon, ClockIcon, FileTextIcon,
  GaugeIcon, GitBranchIcon, GitPullRequestArrowIcon, LockIcon, MenuIcon, MoreVerticalIcon, PencilIcon, PlayIcon,
  PowerIcon, CornerUpLeftIcon, RefreshCwIcon, ScissorsIcon, ShieldAlertIcon, CpuIcon, TriangleAlertIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSignal } from '@/state/createStore';
import type { Instance } from '@/state/types';
import {
  getTierList, getActiveTierEnabled, getActiveTierBackend, getTierLabel, backendIdOf, getBackends, getBackendLabel,
  getBackendModels, getEffortLevels, CLAUDE_BACKEND,
} from '@shared/models';
import { ApiError, apiFetch } from '@shared/http';
import { CONDUCT_PROJECT, projectLabel } from '@shared/conductors';
import { autoResumeBadge, formatAutoResumeTime } from '@shared/usage';
import { send, stickyPrompt } from '@/app/controller';
import { trackSwipes } from '@/conversation/stickyPrompt';
import { modelsSignal } from '@/app/models';
import { uiStore, isCallUsageShown, setCallUsageShown } from '@/app/ui';
import { respawnActive, syncWorktree } from '@/app/sessionActions';
import { isSessionMuted, muteSession, mutesSignal } from '@/features/notifications/mutes';
import { openPruneDialog, openRenameDialog, openStatsDialog, openSummaryDialog } from '@/features/dialogs/api';
import { confirmDialog, toast } from '@/ui/feedback';
import { Dot, Hint, OWNER_BAR, ownerStyle } from '@/features/sidebar/rows';
import { isBackToOwnerKey, openOwner, useWorkerOwner, type WorkerOwner } from './workerOwner';
import { cn } from '@/lib/utils';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';

const BETWEEN_TURNS_TITLE = 'Model can only be changed between turns';
export const RESTART_BUSY_TITLE = 'Switching restarts the session. Wait for the running turn to finish.';

export const isEnforcing = (level?: string) => level !== 'warn';
const isBetweenTurns = (inst: Instance) => inst.status === 'idle';

/** The debug route's own failure answers `{ok:false, reason}` with no `error`: its reason, else none. */
function debugRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { error?: unknown; reason?: unknown } | null;
  return typeof body?.error !== 'string' && typeof body?.reason === 'string' ? body.reason : null;
}

type ModelSwitch = NonNullable<Instance['modelSwitch']>;
/** A restart switch (or its failure) that crossed backends: the badges then name the target's backend. */
const crossed = (sw: ModelSwitch) => !!sw.fromBackend && !!sw.toBackend && sw.fromBackend !== sw.toBackend;

/** The backend the session runs on. Mid restart switch `inst.backend` may already name the unconfirmed target, so the switch's `fromBackend` wins. */
export function runningBackendOf(inst: Instance): string {
  return inst.modelSwitch?.fromBackend ?? inst.backend ?? CLAUDE_BACKEND;
}

/**
 * How the picker offers a model: `live` (a Claude session to a Claude model,
 * switched in place between turns) or `restart` (every other pair: the server
 * restarts the CLI on the target backend and model and keeps the conversation;
 * disabled while anything runs). Display only: the server decides.
 */
export function modelEntryState(inst: Instance, binding: { backend?: string; model: string }) {
  const running = runningBackendOf(inst);
  const target = backendIdOf(binding);
  if (running === CLAUDE_BACKEND && target === CLAUDE_BACKEND) {
    const disabled = !isBetweenTurns(inst);
    return { kind: 'live' as const, disabled, title: disabled ? BETWEEN_TURNS_TITLE : '' };
  }
  const busy = !isBetweenTurns(inst) || inst.displayStatus === 'running' || !!inst.modelSwitch;
  const title = busy ? RESTART_BUSY_TITLE
    : target === running ? 'Restarts the session on this model. The conversation is kept.'
    : `Restarts the session on ${getBackendLabel(target)}. The conversation is kept.`;
  return { kind: 'restart' as const, disabled: busy, title };
}

type Entry = { target: { tier?: string; model?: string; backend?: string }; label: string; state: ReturnType<typeof modelEntryState>; running: boolean; selected: boolean; model: string };

/**
 * The picker's entries: enabled tiers grouped by backend, the session's own
 * first, then every substitution backend's registered models, listed even when
 * a tier there binds the same model (the two picks send different frames).
 * `target` is what a click sends: `{tier}` or `{model, backend}`. `running` is
 * "lands on the running model"; `selected` is "carries the ✓": the registered
 * entry when one is listed, else the tier, since the session records no tier.
 */
export function modelGroups(inst: Instance): [string, Entry[]][] {
  const runningBackend = runningBackendOf(inst);
  const runningModel = inst.modelSwitch?.from ?? inst.model;
  const cur = typeof runningModel !== 'string' ? null
    : runningBackend === CLAUDE_BACKEND ? runningModel.replace(/\[(200k|1m)\]$/, '') : runningModel;
  const isRunning = (backend: string, model: string) => backend === runningBackend && model === cur;
  const groups = new Map<string, Entry[]>([[runningBackend, []]]);
  for (const tier of getTierList() as string[]) {
    if (!getActiveTierEnabled(tier)) continue;
    const binding = getActiveTierBackend(tier);
    const id = backendIdOf(binding);
    if (!groups.has(id)) groups.set(id, []);
    const running = isRunning(id, binding.model);
    groups.get(id)!.push({ target: { tier }, label: getTierLabel(tier), state: modelEntryState(inst, binding), running, selected: running, model: binding.model });
  }
  for (const { id } of getBackends()) {
    if (id === CLAUDE_BACKEND) continue;
    if (!groups.has(id)) groups.set(id, []);
    const group = groups.get(id)!;
    const registered = new Set<string>();
    for (const { model, label } of getBackendModels(id)) {
      const binding = { backend: id, model };
      const running = isRunning(id, model);
      registered.add(model);
      group.push({ target: binding, label, state: modelEntryState(inst, binding), running, selected: running, model });
    }
    for (const e of group) if (e.target.tier !== undefined && registered.has(e.model)) e.selected = false;
  }
  return [...groups].filter(([, e]) => e.length);
}

async function wsAck(t: string, payload: Record<string, unknown>) {
  return send(t, payload, { ack: true });
}

export function ModeToggle({ inst }: { inst: Instance }) {
  const disabled = inst.status === 'turn' || inst.status === 'crashed' || inst.status === 'exited';
  const set = async (mode: string) => {
    if (inst.mode === mode) return;
    try { await wsAck('mode', { id: inst.id, mode }); }
    catch (e: any) { toast.error('Mode change failed', e.message); }
  };
  return (
    <div className={cn('flex h-8 items-center rounded-lg bg-muted p-0.5 text-xs font-medium', disabled && 'opacity-60')} role="group" aria-label="Permission mode">
      {([['plan', 'Plan'], ['bypassPermissions', 'Code']] as const).map(([mode, label]) => (
        <Tooltip key={mode}>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={inst.mode === mode}
              onClick={() => set(mode)}
              className={cn(
                'h-full rounded-md px-3 transition-colors disabled:cursor-not-allowed',
                'not-aria-pressed:text-muted-foreground not-aria-pressed:hover:text-foreground',
                'aria-pressed:bg-primary/15 aria-pressed:text-accent-foreground aria-pressed:shadow-xs',
              )}
            >
              {label}
            </button>
          </TooltipTrigger>
          <TooltipContent>{mode === 'plan' ? 'Plan first, ask before changing anything' : 'Write code and run commands without asking'}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** A conducted worker's owner, in the owner's colour; a button back to it when it can be reached. */
function OwnerChip({ owner }: { owner: Extract<WorkerOwner, { kind: 'owned' }> }) {
  const body = (
    <>
      <CornerUpLeftIcon className="size-3 shrink-0" />
      <span className="min-w-0 overflow-clip text-ellipsis whitespace-nowrap">{owner.label}</span>
    </>
  );
  const cls = cn('flex min-w-0 max-w-[50%] shrink items-center gap-1 pl-2', OWNER_BAR);
  if (!owner.target) {
    return (
      <Hint label={`${owner.label} isn't running or listed`}>
        <span data-owner-chip className={cls} style={ownerStyle(owner.sessionId)}>{body}</span>
      </Hint>
    );
  }
  return (
    <Hint label={`Worker of ${owner.label} · Alt+↑`}>
      <button
        type="button"
        data-owner-chip
        className={cn(cls, 'cursor-pointer hover:text-foreground')}
        style={ownerStyle(owner.sessionId)}
        aria-label={`Back to ${owner.label}`}
        aria-keyshortcuts="Alt+ArrowUp"
        onClick={() => openOwner(owner)}
      >
        {body}
      </button>
    </Hint>
  );
}

export function SessionHeader({ inst, onMenu }: { inst: Instance; onMenu: () => void }) {
  useSignal(modelsSignal);
  useSignal(mutesSignal);
  const projectName = projectLabel(inst.project);
  const worktree = inst.worktree?.worktreeName ? inst.worktree : null;
  const canMenu = ['idle', 'turn', 'spawning'].includes(inst.status);
  // Sync sits in the bar from md up and in ⋮ below it; the one query places it
  // and decides whether a stopped worktree session has a ⋮ at all.
  const wide = useMediaQuery(WIDE_QUERY);
  const menu = canMenu || (!!worktree && !wide);
  const between = isBetweenTurns(inst);
  const muted = isSessionMuted(inst.sessionId);
  const enforcing = isEnforcing(inst.playbookEnforcement);
  const resumeBadge = autoResumeBadge(inst);
  React.useSyncExternalStore(uiStore.subscribe, () => uiStore.get().callUsageShown);
  const showCallUsage = isCallUsageShown(inst.sessionId);

  async function terminate() {
    if (inst.status === 'turn') { send('interrupt', { id: inst.id }); return; }
    if (await confirmDialog({ title: 'Terminate this session?', description: 'The process stops. The transcript is kept and the session stays resumable.', confirmLabel: 'Terminate', destructive: true })) {
      send('kill', { id: inst.id });
    }
  }

  async function startDebug() {
    try {
      const result = await apiFetch<{ ok?: boolean; debugDir?: string } | null>(`/api/instances/${inst.id}/debug`, { method: 'POST' });
      if (!result?.ok) throw new Error('failed to enable debug');
      toast.success('Debug capture started', `Writing to ${result.debugDir}`);
    } catch (e: any) {
      toast.error('Could not enable debug capture', debugRefusal(e) ?? e.message);
    }
  }

  async function pickModel(target: Entry['target']) {
    try { await wsAck('model', { id: inst.id, ...target }); }
    catch (e: any) { toast.error('Change model failed', e.message); }
  }

  async function pickEffort(level: string) {
    try { await wsAck('effort', { id: inst.id, effort: level }); }
    catch (e: any) { toast.error('Change effort failed', e.message); }
  }

  const owner = useWorkerOwner(inst);
  const backTarget = owner.kind === 'owned' && owner.target ? owner : null;
  // Alt+ArrowUp goes up to the owner while this worker is showing.
  React.useEffect(() => {
    if (!backTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isBackToOwnerKey(e)) return;
      e.preventDefault();
      openOwner(backTarget);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [backTarget]);

  const headerRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (!headerRef.current) return;
    return trackSwipes(headerRef.current, () => stickyPrompt.reveal(), () => stickyPrompt.conceal());
  }, []);

  const groups = canMenu ? modelGroups(inst) : [];
  const restartShown = groups.some(([, es]) => es.some((e) => e.state.kind === 'restart'));

  return (
    <header ref={headerRef} className="touch-pan-x touch-pinch-zoom sticky top-[env(safe-area-inset-top,0px)] z-10 flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 py-2 backdrop-blur md:px-5" data-session-header>
      <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open sidebar" onClick={onMenu}><MenuIcon /></Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Dot status={inst.displayStatus ?? inst.status} awaitingWake={inst.awaitingWake} waitingOnJob={inst.waitingOnJob}
          awaitingUser={inst.awaitingUser} awaitingUserSource={inst.awaitingUserSource} className="ring-offset-background" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 overflow-clip text-sm font-semibold text-ellipsis whitespace-nowrap" title={`session ${inst.sessionId ?? '?'}`}>{inst.title || projectName}</h1>
            {inst.modelSwitch ? (
              <Badge variant="info" className="shrink-0"><RefreshCwIcon className="animate-spin" />Switching to {inst.modelSwitch.to}{crossed(inst.modelSwitch) ? ` on ${inst.modelSwitch.toBackend}` : ''}</Badge>
            ) : inst.status === 'turn' && inst.interrupting ? (
              <Badge variant="warning" className="shrink-0">Stopping…</Badge>
            ) : inst.displayStatus && !['idle', 'turn'].includes(inst.displayStatus) ? (
              <Badge variant={inst.displayStatus === 'crashed' ? 'destructive' : 'secondary'} className="shrink-0">{inst.displayStatus}</Badge>
            ) : null}
            {!inst.modelSwitch && inst.modelSwitchFailure && (
              <Tooltip>
                <TooltipTrigger asChild><Badge variant="destructive" className="shrink-0"><TriangleAlertIcon />Switch failed</Badge></TooltipTrigger>
                <TooltipContent>Switch to {inst.modelSwitchFailure.to}{crossed(inst.modelSwitchFailure) ? ` on ${inst.modelSwitchFailure.toBackend}` : ''} failed: {inst.modelSwitchFailure.error}</TooltipContent>
              </Tooltip>
            )}
            {resumeBadge ? (
              <Tooltip>
                <TooltipTrigger asChild><Badge variant="warning" className="shrink-0"><ClockIcon />{resumeBadge.text}</Badge></TooltipTrigger>
                <TooltipContent className="max-w-64">{resumeBadge.title}</TooltipContent>
              </Tooltip>
            ) : inst.overageActive ? (
              <Badge variant="warning" className="shrink-0"><ClockIcon />{formatAutoResumeTime(inst.overageResetsAt as number) || 'paused'}</Badge>
            ) : null}
          </div>
          {(inst.title || worktree || owner.kind !== 'none') && (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {owner.kind === 'owned' && (
                <OwnerChip owner={owner} />
              )}
              {owner.kind === 'unknown' && (
                <Hint label="Its owner isn't known: this worker was resumed outside its conductor">
                  <span data-owner-chip="unknown" className="shrink-0 whitespace-nowrap">Conducted worker</span>
                </Hint>
              )}
              {inst.title && <span className="min-w-0 overflow-clip text-ellipsis whitespace-nowrap">{projectName}</span>}
              {worktree && <span className="flex min-w-0 items-center gap-1 font-mono"><GitBranchIcon className="size-3 shrink-0" /><span className="min-w-0 overflow-clip text-ellipsis whitespace-nowrap">{worktree.worktreeName}</span><span className="hidden shrink-0 sm:inline">← {worktree.baseBranch}</span></span>}
            </div>
          )}
        </div>
      </div>

      <div className="hidden items-center gap-1.5 lg:flex">
        {inst.model && <Badge variant="outline" className="max-w-48 gap-1 font-normal"><CpuIcon /><span className="min-w-0 overflow-clip text-ellipsis whitespace-nowrap">{inst.model}</span></Badge>}
        {inst.effort && <Badge variant="outline" className="font-normal"><GaugeIcon />{inst.effort}</Badge>}
      </div>

      {worktree && wide && (
        <Button variant="outline" size="sm" onClick={() => void syncWorktree()}>
          <GitPullRequestArrowIcon /> Sync
        </Button>
      )}
      {(inst.status === 'crashed' || inst.status === 'exited') && !inst.modelSwitch && (
        <Button size="sm" onClick={() => void respawnActive()}><PlayIcon /> Resume</Button>
      )}
      {inst.mode === 'plan' && canMenu && inst.autoApprovePlan && (
        <Badge variant="plan" className="hidden sm:inline-flex"><CheckIcon />Auto-approve</Badge>
      )}
      <ModeToggle inst={inst} />

      {menu && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Session actions"><MoreVerticalIcon /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {canMenu && (
              <>
                <DropdownMenuItem disabled={!inst.sessionId} onSelect={() => inst.sessionId && openRenameDialog(inst.sessionId, inst.title ?? '')}><PencilIcon /> Rename</DropdownMenuItem>
                <DropdownMenuItem disabled={!inst.sessionId} onSelect={() => inst.sessionId && openSummaryDialog(inst.sessionId)}><FileTextIcon /> Summarize session</DropdownMenuItem>
                <DropdownMenuItem disabled={!inst.sessionId} onSelect={() => inst.sessionId && openStatsDialog(inst.sessionId)}><BarChart3Icon /> Statistics</DropdownMenuItem>
                <DropdownMenuCheckboxItem checked={showCallUsage} onCheckedChange={(v) => setCallUsageShown(inst.sessionId, !!v)}>Show mid-turn statistics</DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={!inst.sessionId || !!inst.modelSwitch || !between} title={between ? 'Switch this session to another model' : BETWEEN_TURNS_TITLE}><BrainIcon /> Change model</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-64">
                    {groups.map(([backendId, entries]) => (
                      <React.Fragment key={backendId}>
                        <DropdownMenuLabel>{getBackendLabel(backendId)}</DropdownMenuLabel>
                        {entries.map((e) => (
                          <DropdownMenuItem
                            key={JSON.stringify(e.target)}
                            disabled={e.state.disabled}
                            title={e.state.title || undefined}
                            onSelect={() => void pickModel(e.target)}
                          >
                            <span className="flex-1">{e.label}</span>
                            {e.state.kind === 'restart' && <RefreshCwIcon className="size-3" data-restart-mark />}
                            {e.selected && <CheckIcon />}
                          </DropdownMenuItem>
                        ))}
                      </React.Fragment>
                    ))}
                    {!groups.some(([, es]) => es.some((e) => !e.running)) && (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No other model is available. Add one in Settings → Models.</div>
                    )}
                    {restartShown && <div className="px-2 py-1.5 text-[11px] text-muted-foreground">↻ restarts the session · the conversation is kept</div>}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={!between || !inst.sessionId || !!inst.modelSwitch} title={between ? 'Change how hard this session reasons, without restarting' : 'Effort can only be changed between turns'}><GaugeIcon /> Change effort</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {(getEffortLevels() as string[]).map((level) => (
                      <DropdownMenuItem key={level} onSelect={() => void pickEffort(level)}>
                        <span className="flex-1 capitalize">{level}</span>{level === inst.effort && <CheckIcon />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  disabled={!between || !inst.sessionId}
                  title={between ? "Shrink this session's context by stubbing out old tool payloads and thinking — mechanical, no LLM pass, no token cost" : 'Prune is only available between turns'}
                  onSelect={() => openPruneDialog(inst.id)}
                ><ScissorsIcon /> Prune context…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!inst.sessionId} onSelect={() => muteSession(inst.sessionId, !muted)}>
                  {muted ? <><BellIcon /> Unmute notifications</> : <><BellOffIcon /> Mute notifications</>}
                </DropdownMenuItem>
                {inst.mode === 'plan' && (
                  <DropdownMenuCheckboxItem checked={!!inst.autoApprovePlan} onCheckedChange={(v) => send('auto_approve_plan', { id: inst.id, enabled: !!v })}>
                    Auto-approve plans
                  </DropdownMenuCheckboxItem>
                )}
                {inst.project === CONDUCT_PROJECT && (
                  <DropdownMenuCheckboxItem
                    checked={enforcing}
                    onCheckedChange={async () => {
                      try { await wsAck('playbook_enforcement', { id: inst.id, mode: enforcing ? 'warn' : 'enforce' }); }
                      catch (e: any) { toast.error('Playbook enforcement change failed', e.message); }
                    }}
                  >
                    {enforcing ? <LockIcon className="size-4 text-muted-foreground" /> : <ShieldAlertIcon className="size-4 text-warning" />}
                    <span className="ml-2">Enforce playbooks</span>
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuItem disabled={!!inst.debug} onSelect={() => void startDebug()} title={inst.debug ? `Mirroring to ${inst.debugDir ?? '(unknown path)'}` : 'Mirror CLI stdin/stdout/stderr to the debug directory'}>
                  <BugIcon /> {inst.debug ? 'Debug capture on' : 'Start debug capture'}
                </DropdownMenuItem>
              </>
            )}
            {worktree && !wide && (
              <DropdownMenuItem onSelect={() => void syncWorktree()}><GitPullRequestArrowIcon /> Sync worktree</DropdownMenuItem>
            )}
            {canMenu && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void terminate()}>
                  <PowerIcon /> {inst.status === 'turn' ? 'Interrupt' : 'Terminate'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
