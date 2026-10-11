import { ChevronRightIcon } from 'lucide-react';
import { conductorTitle, sessionFromInstance, stageText, workersOf } from '@/lib/core/conductors.js';
import { conductorColor } from '@/lib/core/conductorColor.js';
import { cn } from '@/lib/utils';
import type { Instance, Project } from '@/state/types';
import { resumeSession } from '@/app/sessionActions';
import { selectInstance } from '@/app/controller';
import { CONDUCT_PROJECT, chipsOf, wtName } from './derive';
import { setConductorOpen, sidebarStore, useSidebarUi } from './state';
import { Ago, CloseButton, Dot, ProjectRow, PromoteButton, SessionRow, UnreadPill, WorktreeHead } from './rows';
import type { SidebarModel } from './useSidebarModel';

function WorkerList({ m, workers, projectName, worktreeName }: { m: SidebarModel; workers: Instance[]; projectName: string; worktreeName: string | null }) {
  const rows = workers.filter((w) => w.sessionId).map(sessionFromInstance)
    .sort((a: any, b: any) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return (
    <ul className="ml-3 space-y-px border-l border-sidebar-border pl-1.5">
      {rows.map((s: any) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          projectName={projectName}
          worktreeName={worktreeName}
          activeId={m.activeId}
          unread={m.unread.get(s.sessionId) ?? 0}
          showDelete={false}
          stage={stageText(s)}
        />
      ))}
    </ul>
  );
}

/** A conductor's expanded tree: each chip project, its main-checkout workers, then its worktrees. */
function ConductorTree({ m, sid, chips }: { m: SidebarModel; sid: string; chips: any[] }) {
  const workers = workersOf(sid, m.instances) as Instance[];
  const byName = new Map(m.projects.map((p) => [p.name, p]));
  return (
    <ul className="space-y-0.5 py-1 pl-1">
      {chips.map((chip) => {
        const p: Project = byName.get(chip.project) ?? ({ name: chip.project, worktrees: [] } as unknown as Project);
        const mine = workers.filter((w) => w.project === chip.project);
        const direct = mine.filter((w) => !wtName(w));
        const byWt = new Map<string, Instance[]>();
        for (const w of mine) {
          const n = wtName(w);
          if (!n) continue;
          if (!byWt.has(n)) byWt.set(n, []);
          byWt.get(n)!.push(w);
        }
        const listed = new Map<string, any>((Array.isArray(p.worktrees) ? p.worktrees : []).map((w: any) => [w.worktreeName, w]));
        const recorded = (chip.worktrees as string[]).filter((n) => listed.has(n) && !byWt.has(n));
        const names = [...byWt.keys(), ...recorded].sort((a, b) => a.localeCompare(b));
        return (
          <li key={chip.project}>
            <ProjectRow project={p} readOnly />
            {direct.length > 0 && <WorkerList m={m} workers={direct} projectName={chip.project} worktreeName={null} />}
            {names.length > 0 && (
              <ul className="ml-3 space-y-px border-l border-sidebar-border pl-1.5">
                {names.map((n) => {
                  const ws = byWt.get(n);
                  const wt = listed.get(n) ?? { ...(ws![0].worktree as any), worktreeName: n };
                  return (
                    <li key={n} data-idle={!ws || undefined}>
                      <WorktreeHead project={chip.project} wt={wt} readOnly dim={!ws} />
                      {ws && <WorkerList m={m} workers={ws} projectName={chip.project} worktreeName={n} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ConductorBlock({ m, c, open }: { m: SidebarModel; c: any; open: boolean }) {
  const sid: string = c.sessionId;
  const { text, untitled } = conductorTitle(c);
  const chips = chipsOf(sid, m.instances, m.spawns, m.registered);
  const unread = m.unread.get(sid) ?? 0;
  const active = !!c.instanceId && c.instanceId === m.activeId;
  const openSession = () => {
    if (c.instanceId) selectInstance(c.instanceId, { userGesture: true });
    else void resumeSession({ projectName: CONDUCT_PROJECT, worktreeName: null, sessionId: sid });
  };
  return (
    <li
      className={cn('relative rounded-lg pl-[3px]', !c.live && 'opacity-80')}
      style={{ '--owner-color': conductorColor(sid) } as React.CSSProperties}
      data-conductor={sid}
    >
      <span className={cn('absolute inset-y-1 left-0 w-[3px] rounded-full bg-[var(--owner-color)]', !c.live && 'opacity-50')} />
      <div
        role="button"
        tabIndex={0}
        title={sid}
        onClick={openSession}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(); } }}
        data-active={active || undefined}
        className={cn(
          'group/row flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1 pl-0.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring',
          active && 'bg-sidebar-accent ring-1 ring-border',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label="Show workers"
          onClick={(e) => { e.stopPropagation(); setConductorOpen(sid, !open); }}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <Dot
          status={c.instanceDisplayStatus ?? c.instanceStatus ?? 'offline'}
          awaitingWake={c.instanceAwaitingWake}
          waitingOnJob={c.instanceWaitingOnJob}
          awaitingUser={c.live ? c.awaitingUser : null}
          awaitingUserSource={c.awaitingUserSource}
        />
        <span className={cn('min-w-[2em] flex-1 truncate', untitled && 'text-muted-foreground italic', active && 'text-foreground',
          // Selection is the fill and ring above; weight marks unread only (docs/features.md → Selected session).
          unread > 0 && 'font-semibold')}>
          {text}
        </span>
        <Ago ms={c.lastActivity} />
        <UnreadPill n={unread} />
        {c.live && c.instanceTemp && (
          <PromoteButton getArgs={() => ({ projectName: CONDUCT_PROJECT, instanceId: c.instanceId, preview: text })} />
        )}
        {!c.live && (
          <CloseButton args={{
            projectName: CONDUCT_PROJECT, worktreeName: null, sessionId: sid, instanceId: c.instanceId,
            status: c.instanceDisplayStatus ?? c.instanceStatus, temp: c.instanceTemp, preview: text, synthetic: !c.onDisk,
          }} />
        )}
      </div>
      <div className="flex flex-wrap gap-1 pt-0.5 pb-1.5 pl-8" data-chips>
        {chips.length === 0
          ? <span className="text-[11px] text-muted-foreground/70 italic">no live workers</span>
          : chips.map((ch: any) => (
            <span
              key={`${ch.live ? 'live' : 'idle'}:${ch.project}`}
              data-chip={ch.live ? 'live' : 'idle'}
              className={cn(
                'rounded-full px-2 text-[11px] leading-5',
                ch.live ? 'bg-[color-mix(in_oklch,var(--owner-color)_22%,transparent)] font-medium text-foreground' : 'border border-dashed border-muted-foreground/40 text-muted-foreground',
              )}
            >
              {ch.project}
            </span>
          ))}
      </div>
      {open && <ConductorTree m={m} sid={sid} chips={chips} />}
    </li>
  );
}

export function ConductorsList({ m }: { m: SidebarModel }) {
  const ui = useSidebarUi();
  const { live, inactive } = m.conductors;
  if (live.length === 0 && inactive.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground" data-conductors-empty>No conductors yet · tap Conduct</div>;
  }
  return (
    <div data-conductor-list>
      <ul className="space-y-1">
        {live.map((c) => <ConductorBlock key={c.sessionId} m={m} c={c} open={ui.expandedConductors.includes(c.sessionId)} />)}
      </ul>
      {inactive.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={ui.inactiveOpen}
            onClick={() => sidebarStore.set({ inactiveOpen: !ui.inactiveOpen })}
            className="flex h-7 w-full items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase hover:bg-sidebar-accent"
          >
            <ChevronRightIcon className={cn('size-3.5 transition-transform', ui.inactiveOpen && 'rotate-90')} />
            Inactive ({inactive.length})
          </button>
          {ui.inactiveOpen && (
            <ul className="space-y-1">
              {inactive.map((c) => <ConductorBlock key={c.sessionId} m={m} c={c} open={ui.expandedConductors.includes(c.sessionId)} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
