import * as React from 'react';
import { CircleCheckIcon, CircleDotIcon, CircleIcon, CircleXIcon, LoaderCircleIcon, ListTodoIcon, BotIcon, ChevronDownIcon, PauseIcon, ZapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { OctopusMaestro } from '@/components/mascot/Octopus';
import { useSignal, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { peekTaskTracker, trackerSignal } from '@/app/trackers';
import { selectInstance, send } from '@/app/controller';
import { runLabel, waitingOn } from '@/lib/core/needsYou.js';
import { formatAgo } from '@/lib/time';
import { cn } from '@/lib/utils';

/** The model's live task list (TaskCreate / TaskUpdate), while any task is open. */
export function TaskPanel({ inst }: { inst: Instance }) {
  useSignal(trackerSignal);
  const t = peekTaskTracker(inst.id);
  if (!t || !t.isVisible()) return null;
  const tasks: { id: string; subject: string; status: string; activeForm?: string | null }[] = t.list();
  const done = t.completedCount();
  return (
    <Collapsible defaultOpen className="rounded-xl border bg-card/80 shadow-xs backdrop-blur" data-task-panel>
      <CollapsibleTrigger className="group/tp flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <ListTodoIcon className="size-4 text-primary" />
        <span className="font-medium">Tasks</span>
        <span className="text-xs text-muted-foreground tabular-nums">{done}/{tasks.length} done</span>
        <div className="ml-2 h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / Math.max(1, tasks.length)) * 100}%` }} />
        </div>
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=closed]/tp:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-48 space-y-1 overflow-y-auto border-t px-3 py-2 text-sm">
          {tasks.map((task) => (
            <li key={task.id} className={cn('flex items-start gap-2', task.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>
              {task.status === 'completed' ? <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
                : task.status === 'in_progress' ? <LoaderCircleIcon className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                : <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
              <span>{task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function workerLabel(w: Instance) {
  const raw = (w.title || w.firstPrompt || '').replace(/\s+/g, ' ').trim();
  if (raw) return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  return `${w.project} · ${w.id.slice(0, 8)}`;
}

/** Workers this conductor spawned (MCP spawn_instance), one tap away. */
export function SubagentPanel({ inst }: { inst: Instance }) {
  const instances = useStore(appStore, (s) => s.instances);
  const workers = React.useMemo(() => instances.filter((i) => i.callerInstanceId === inst.id), [instances, inst.id]);
  if (!workers.length) return null;
  return (
    <Collapsible defaultOpen className="rounded-xl border bg-card/80 shadow-xs backdrop-blur" data-subagent-panel>
      <CollapsibleTrigger className="group/sp flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <BotIcon className="size-4 text-plan" />
        <span className="font-medium">Workers</span>
        <span className="text-xs text-muted-foreground">{workers.length}</span>
        <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground transition-transform group-data-[state=closed]/sp:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-48 overflow-y-auto border-t py-1 text-sm">
          {workers.map((w) => {
            const awaiting = waitingOn(w.displayStatus, w.awaitingWake, w.waitingOnJob) != null;
            const s = w.displayStatus;
            const Icon = awaiting || s === 'turn' || s === 'running' ? LoaderCircleIcon
              : s === 'idle' ? CircleDotIcon : s === 'exited' ? CircleCheckIcon : s === 'crashed' ? CircleXIcon : CircleIcon;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  title={awaiting ? runLabel(w.displayStatus, w.awaitingWake, w.waitingOnJob) : undefined}
                  onClick={() => selectInstance(w.id, { push: true, userGesture: true })}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60"
                >
                  <Icon className={cn('size-3.5 shrink-0',
                    (awaiting || s === 'turn' || s === 'running') && 'animate-spin text-primary',
                    s === 'idle' && 'text-success', s === 'crashed' && 'text-destructive', s === 'exited' && 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1 truncate">{workerLabel(w)}</span>
                  {w.playbook && w.stage && <span className="shrink-0 rounded bg-plan/12 px-1.5 text-[11px] text-plan" title={`playbook ${w.playbook}, stage ${w.stage}`}>{w.playbook} · {w.stage}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** "Working…" with interrupt controls while a turn runs; "Last response …" otherwise. */
export function TurnIndicator({ inst }: { inst: Instance }) {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (inst.status === 'turn') {
    const interrupting = !!inst.interrupting;
    return (
      <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground" data-turn-indicator="working">
        <OctopusMaestro mood="conducting" className="size-7" />
        <span className={cn(!interrupting && 'animate-pulse')}>{interrupting ? 'Stopping at the next safe point…' : 'Working…'}</span>
        <div className="ml-auto flex items-center gap-1">
          {!interrupting && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => send('interrupt', { id: inst.id })} title="Stop at the next output boundary. Finished blocks and tool results are kept.">
              <PauseIcon /> Interrupt
            </Button>
          )}
          {interrupting && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => send('interrupt', { id: inst.id, force: true })} title="Abort immediately. In-progress work is discarded.">
              <ZapIcon /> Interrupt now
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (!inst.lastResponseAt) return null;
  return <div className="px-1 text-xs text-muted-foreground" data-turn-indicator="idle">Last response {formatAgo(inst.lastResponseAt)}</div>;
}
