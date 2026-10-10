import * as React from 'react';
import {
  ArrowUpIcon, FolderGit2Icon, FolderIcon, GitBranchIcon, GitCommitHorizontalIcon, LockIcon, PlusIcon, ServerIcon,
  ServerOffIcon, Trash2Icon, XIcon, FileDiffIcon, ArchiveIcon, SquareIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { conductorColor } from '@/lib/core/conductorColor.js';
import { closeActionOf, CLOSE_TITLES } from '@/lib/core/closeAction.js';
import { needsYouTitle, runLabel } from '@/lib/core/needsYou.js';
import { formatAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Project } from '@/state/types';
import { closeSession, promoteSession, removeWorktree, resumeSession, type CloseArgs } from '@/app/sessionActions';
import { selectInstance } from '@/app/controller';
import { closeSidebarOnMobile } from '@/app/ui';
import { openDeleteProjectDialog, openProjectRemoteDialog, openSpawnDialog } from '@/features/dialogs/api';
import { openCommits, openReview } from '@/features/views/api';
import { dotState, sessionLabel, type SessionItem } from './derive';
import { useAgoTick } from './state';

/** The owner bar: a 3px left bar in the conductor's colour. */
export function ownerStyle(owner: string | null | undefined): React.CSSProperties | undefined {
  return owner ? ({ '--owner-color': conductorColor(owner) } as React.CSSProperties) : undefined;
}
export const OWNER_BAR = 'shadow-[inset_3px_0_0_var(--owner-color)]';

export function Hint({ label, children }: { label: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-72 whitespace-pre-line">{label}</TooltipContent>
    </Tooltip>
  );
}

// ── Status dot ───────────────────────────────────────────────────────────

export function Dot({ status, awaitingWake, waitingOnJob, awaitingUser = null, awaitingUserSource = null, unreadRing = false, className }: {
  status?: string | null; awaitingWake?: boolean; waitingOnJob?: boolean;
  awaitingUser?: string | null; awaitingUserSource?: string | null; unreadRing?: boolean; className?: string;
}) {
  const d = dotState({ status, awaitingWake, waitingOnJob, awaitingUser });
  const s = d.status;
  const running = s === 'turn' || s === 'running';
  const fill = running ? 'bg-success'
    : s === 'spawning' ? 'bg-warning'
    : s === 'crashed' ? 'bg-destructive'
    : s === 'exited' ? 'bg-transparent ring-1 ring-inset ring-destructive/70'
    : s === 'offline' ? 'bg-transparent ring-1 ring-inset ring-muted-foreground/50'
    : d.waiting ? 'bg-info'
    : d.needsYou ? 'bg-warning'
    : 'bg-muted-foreground/45';
  const title = d.needsYou
    ? needsYouTitle({ status: s, awaitingWake, waitingOnJob, awaitingUser, awaitingUserSource })
    : d.waiting === 'worker' ? 'idle — waiting on a worker'
    : d.waiting === 'job' ? 'idle — waiting on a background job'
    : runLabel(s, awaitingWake, waitingOnJob);
  return (
    <span
      className={cn('relative inline-flex size-2 shrink-0 rounded-full', fill,
        running && !d.needsYou && 'animate-pulse',
        d.needsYou && 'ring-2 ring-warning ring-offset-1 ring-offset-sidebar',
        unreadRing && !d.needsYou && 'ring-2 ring-info ring-offset-1 ring-offset-sidebar',
        className)}
      title={title}
      aria-label={title}
      data-dot={s}
      data-needs-you={d.needsYou || undefined}
    />
  );
}

// ── Small parts ──────────────────────────────────────────────────────────

export function Ago({ ms, className }: { ms?: number | null; className?: string }) {
  useAgoTick();
  return <span className={cn('shrink-0 text-[11px] text-muted-foreground tabular-nums', className)} data-ago>{formatAgo(ms ?? 0)}</span>;
}

export function UnreadPill({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span
      className="shrink-0 rounded-full bg-info px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums"
      title={`${n} new turn${n === 1 ? '' : 's'} since you last viewed this session`}
      data-unread
    >
      {n}
    </span>
  );
}

const ROW_ACTION = 'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring';
/** Hover-revealed on pointer devices, always shown on touch and on keyboard focus. */
export const REVEAL = 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100';

export function IconAction({ label, onClick, children, className }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        className={cn(ROW_ACTION, className)}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      >
        {children}
      </button>
    </Hint>
  );
}

export function PromoteButton({ getArgs }: { getArgs: () => { projectName: string; instanceId: string; preview?: string | null } }) {
  return (
    <IconAction label="Make persistent" onClick={() => void promoteSession(getArgs())} className="text-primary">
      <ArrowUpIcon className="size-3.5" />
    </IconAction>
  );
}

export function CloseButton({ args }: { args: CloseArgs }) {
  const action = closeActionOf({ instanceId: args.instanceId ?? null, status: args.status ?? null, temp: !!args.temp }) as 'stop' | 'archive';
  return (
    <IconAction label={CLOSE_TITLES[action]} onClick={() => void closeSession(args)} className={REVEAL}>
      {action === 'stop' ? <SquareIcon className="size-3" /> : <ArchiveIcon className="size-3.5" />}
    </IconAction>
  );
}

// ── Session row ──────────────────────────────────────────────────────────

export function SessionRow({ session, projectName, worktreeName, activeId, unread, showOwner = false, showDelete = true, stage = null, ownerTitle }: {
  session: SessionItem; projectName: string; worktreeName: string | null; activeId: string | null; unread: number;
  showOwner?: boolean; showDelete?: boolean; stage?: string | null; ownerTitle?: (sid: string) => string;
}) {
  const label = sessionLabel(session);
  const status = session.instanceDisplayStatus ?? session.instanceStatus ?? 'offline';
  const live = !!session.instanceId;
  const active = live && session.instanceId === activeId;
  const owner = showOwner ? session.ownerSessionId ?? null : null;
  const title = (session.title ?? '').trim();
  const preview = (session.firstPrompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
  const tooltip = [session.sessionId, title && preview ? preview : null, owner ? `conductor: ${ownerTitle?.(owner) ?? owner}` : null].filter(Boolean).join('\n');
  const showPromote = !!session.instanceTemp && live && status !== 'exited' && status !== 'crashed';
  const open = () => {
    if (session.instanceId) selectInstance(session.instanceId, { userGesture: true });
    else void resumeSession({ projectName, worktreeName, sessionId: session.sessionId });
  };
  return (
    <li className="group/row relative" data-session-row={session.sessionId}>
      <div
        role="button"
        tabIndex={0}
        title={tooltip}
        onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
        style={ownerStyle(owner)}
        data-active={active || undefined}
        className={cn(
          'flex min-h-8 cursor-pointer items-center gap-2 rounded-md py-1 pr-1 pl-2 text-sm text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          live && 'text-foreground/90',
          active && 'bg-sidebar-accent font-medium text-foreground ring-1 ring-border',
          unread > 0 && 'font-semibold text-foreground',
          owner && OWNER_BAR,
        )}
      >
        <Dot status={status} awaitingWake={session.instanceAwaitingWake} waitingOnJob={session.instanceWaitingOnJob} />
        <span className="flex min-w-[2em] flex-1 flex-col">
          {/* Temp rows read warm, conducted rows cool; a temp conducted row stays warm. */}
          <span className={cn('truncate', !title && !preview && 'italic', session.instanceTemp ? 'text-primary' : (session as any).conducted && 'text-info')}>{label}</span>
          {stage && <span className="truncate text-[11px] font-normal text-plan">{stage}</span>}
        </span>
        <Ago ms={session.lastActivity} />
        <UnreadPill n={unread} />
        {showPromote && <PromoteButton getArgs={() => ({ projectName, instanceId: session.instanceId!, preview: label })} />}
        {showDelete && (
          <CloseButton args={{
            projectName, worktreeName, sessionId: session.sessionId, instanceId: session.instanceId ?? null,
            status: session.instanceDisplayStatus ?? session.instanceStatus ?? null, temp: !!session.instanceTemp,
            preview: label, synthetic: !!session.synthetic,
          }} />
        )}
      </div>
    </li>
  );
}

// ── Pills ────────────────────────────────────────────────────────────────

export function Pill({ children, title, className }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground', className)}>
      {children}
    </span>
  );
}

/** ↑ahead ↓behind against a base. */
export function AheadBehind({ ahead, behind, title }: { ahead?: number | null; behind?: number | null; title: string }) {
  if (!(ahead! > 0) && !(behind! > 0)) return null;
  return (
    <Pill title={title} className="text-info">
      {ahead! > 0 && <span>↑{ahead}</span>}
      {behind! > 0 && <span className="text-warning">↓{behind}</span>}
    </Pill>
  );
}

function upstreamTitle(ms: { ahead: number; behind: number; upstream: string }) {
  if (ms.ahead > 0 && ms.behind > 0) return `${ms.ahead} commit(s) ahead of ${ms.upstream}, ${ms.behind} behind — pull (or rebase) then push`;
  if (ms.ahead > 0) return `${ms.ahead} commit(s) ahead of ${ms.upstream} — push to publish`;
  return `${ms.behind} commit(s) behind ${ms.upstream} — pull to catch up`;
}

function worktreeTitle(ms: { ahead: number; behind: number }, base: string) {
  if (ms.ahead > 0 && ms.behind > 0) return `${ms.ahead} commit(s) ahead of ${base}, ${ms.behind} behind — rebase, then fast-forward`;
  if (ms.ahead > 0) return `${ms.ahead} commit(s) ahead of ${base} — fast-forward parent to land them`;
  return `${ms.behind} commit(s) behind ${base} — click Sync to catch up`;
}

// ── Project row ──────────────────────────────────────────────────────────

export function ProjectRow({ project: p, readOnly = false, liveCount = 0, instanceCount = 0, chevron, meta }: {
  project: Project; readOnly?: boolean; liveCount?: number; instanceCount?: number; chevron?: React.ReactNode; meta?: React.ReactNode;
}) {
  const remote = !!p.system && p.system !== 'local';
  const unreachable = (p.systemUnreachable as string | null) || null;
  const ms = p.mergeStatus;
  const systemClickable = remote && !unreachable && !readOnly;
  const where = p.remoteId ? `remote '${p.remoteId}' of system '${p.system}'` : `system '${p.system}'`;
  const systemTitle = unreachable
    ?? `This project's tree, git repo and commands live on ${where} at ${p.path}. A worker session runs the claude CLI here and redirects its shell and file tools there.${systemClickable ? ' Click to change which target it is on.' : ''}`;
  return (
    <div className="group/row flex min-h-8 items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent" data-project-row={p.name}>
      {chevron}
      {p.isGitRepo === true ? (
        <IconAction label="Commit history" onClick={() => { closeSidebarOnMobile(); openCommits(p.name); }}>
          <FolderGit2Icon className="size-4" />
        </IconAction>
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"><FolderIcon className="size-4" /></span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={p.path}>{p.name}</span>
      {ms && ms.upstream && ((ms.ahead ?? 0) > 0 || (ms.behind ?? 0) > 0) && (
        <AheadBehind ahead={ms.ahead} behind={ms.behind} title={upstreamTitle(ms as any)} />
      )}
      {p.unbornHead && <Pill title="No commits yet — make a first commit to enable worktrees">no commits</Pill>}
      {p.gitRefusal && <Pill title={p.gitRefusal} className="bg-destructive/12 text-destructive">dubious ownership</Pill>}
      {(remote || unreachable) && (
        systemClickable ? (
          <Hint label={systemTitle}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openProjectRemoteDialog(p); }}
              className="inline-flex max-w-24 shrink-0 items-center gap-1 rounded-full bg-info/12 px-1.5 font-mono text-[10px] leading-4 text-info hover:bg-info/20"
              data-system-pill
            >
              <ServerIcon className="size-3 shrink-0" /><span className="truncate">{p.remoteId ? `${p.system}/${p.remoteId}` : p.system}</span>
            </button>
          </Hint>
        ) : (
          <Pill title={systemTitle} className={cn('max-w-24', unreachable ? 'bg-destructive/12 text-destructive' : 'bg-info/12 text-info')}>
            {unreachable ? <ServerOffIcon className="size-3 shrink-0" /> : <ServerIcon className="size-3 shrink-0" />}
            <span className="truncate" data-system-pill>{p.remoteId ? `${p.system}/${p.remoteId}` : p.system || 'unknown system'}</span>
          </Pill>
        )
      )}
      {meta}
      {liveCount > 0 && <span className="size-1.5 shrink-0 rounded-full bg-success" title={`${liveCount} live`} />}
      {!readOnly && (
        <>
          {!unreachable && (
            <IconAction label="New session" onClick={() => openSpawnDialog(p.name)} className={REVEAL}>
              <PlusIcon className="size-3.5" />
            </IconAction>
          )}
          <IconAction label="Delete project" onClick={() => openDeleteProjectDialog(p, instanceCount)} className={cn(REVEAL, 'hover:text-destructive')}>
            <Trash2Icon className="size-3.5" />
          </IconAction>
        </>
      )}
    </div>
  );
}

// ── Worktree head ────────────────────────────────────────────────────────

export function WorktreeHead({ project, wt, readOnly = false, owner = null, ownerTitle, dim = false, chevron }: {
  project: string; wt: any; readOnly?: boolean; owner?: string | null; ownerTitle?: (sid: string) => string; dim?: boolean; chevron?: React.ReactNode;
}) {
  const ms = wt.mergeStatus;
  return (
    <div
      className={cn('group/row flex min-h-8 items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent', owner && OWNER_BAR, dim && 'opacity-70')}
      style={ownerStyle(owner)}
      title={owner ? `conductor: ${ownerTitle?.(owner) ?? owner}` : undefined}
      data-worktree-row={wt.worktreeName}
    >
      {chevron}
      <IconAction label="Commit history" onClick={() => { closeSidebarOnMobile(); openCommits(project, wt.worktreeName); }}>
        <GitCommitHorizontalIcon className="size-3.5" />
      </IconAction>
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-mono text-xs" title={`${wt.branch ?? ''}\nfrom ${wt.baseBranch} @ ${wt.baseSha?.slice(0, 12) ?? '?'}`}>
        {wt.worktreeName}
      </span>
      {ms && <AheadBehind ahead={ms.ahead} behind={ms.behind} title={worktreeTitle(ms, wt.baseBranch)} />}
      {wt.locked === true && (
        <span title="Locked against merging and against deletion by agents — unlock from its commit history" className="shrink-0 text-warning">
          <LockIcon className="size-3" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">← {wt.baseBranch}</span>
      <IconAction label="Review changes" onClick={() => {
        closeSidebarOnMobile();
        openReview({ title: `${project} / ${wt.worktreeName}`, url: `/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(wt.worktreeName)}/diff` });
      }}>
        <FileDiffIcon className="size-3.5" />
      </IconAction>
      {!readOnly && (
        <>
          <IconAction label="New session in this worktree" onClick={() => openSpawnDialog(project, { worktree: wt.worktreeName })} className={REVEAL}>
            <PlusIcon className="size-3.5" />
          </IconAction>
          <IconAction label="Remove worktree" onClick={() => void removeWorktree(project, wt.worktreeName)} className={cn(REVEAL, 'hover:text-destructive')}>
            <XIcon className="size-3.5" />
          </IconAction>
        </>
      )}
    </div>
  );
}
