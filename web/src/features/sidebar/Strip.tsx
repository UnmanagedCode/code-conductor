import { deriveStrip, isStripEmpty, entryReason, type StripEntry } from '@shared/needsYou';
import { autoResumeBadge } from '@shared/usage';
import * as React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { selectInstance } from '@/app/controller';
import { CloseButton, Dot, OWNER_BAR, ownerStyle } from './rows';
import type { SidebarModel } from './useSidebarModel';

const HEADS = { waiting: 'Waiting on you', running: 'Running', finished: 'Finished' } as const;
type Group = keyof typeof HEADS;

const HEAD_TONE: Record<Group, string> = { waiting: 'text-warning', running: 'text-success', finished: 'text-muted-foreground' };

const FOLDED_KEY = 'code-conductor:strip-folded';

function readFolded(): Group[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((g): g is Group => g in HEADS) : [];
  } catch {
    return [];
  }
}

/** Live top-level sessions that want attention: Waiting → Running (conductors) → Finished.
 *  A group header folds its group (remembered per browser), for long Finished lists. */
export function Strip({ m }: { m: SidebarModel }) {
  const g = deriveStrip({ conductors: m.conductors.live, instances: m.instances });
  const [folded, setFolded] = React.useState<Group[]>(readFolded);
  const toggle = (name: Group) => setFolded((f) => {
    const next = f.includes(name) ? f.filter((x) => x !== name) : [...f, name];
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  if (isStripEmpty(g)) return null;
  const unreadOf = (e: StripEntry, group: Group) => group === 'finished' && (m.unread.get(e.sessionId) ?? 0) > 0;
  return (
    <div className={cn('mx-3 mt-3 space-y-1.5 rounded-xl border px-1.5 py-1.5', g.waiting.length ? 'border-warning/35 bg-warning/6' : 'bg-card/60')} data-strip>
      {(Object.keys(HEADS) as Group[]).filter((name) => g[name].length > 0).map((name) => {
        const entries = g[name];
        const fresh = name === 'finished' ? entries.filter((e) => unreadOf(e, name)).length : 0;
        return (
          <div key={name} data-strip-group={name} data-folded={folded.includes(name) || undefined}>
            <button
              type="button"
              onClick={() => toggle(name)}
              aria-expanded={!folded.includes(name)}
              className={cn('flex w-full items-center gap-1 rounded px-1 pb-0.5 text-left text-[10px] font-semibold tracking-wide uppercase hover:opacity-80', HEAD_TONE[name])}
            >
              <ChevronRightIcon className={cn('size-3 transition-transform', !folded.includes(name) && 'rotate-90')} />
              {HEADS[name]} ({entries.length}{fresh ? ` · ${fresh} new` : ''})
            </button>
            <ul hidden={folded.includes(name)}>
              {entries.map((e) => {
                const unread = unreadOf(e, name);
                const reason = entryReason(e, name, unread);
                const badge = autoResumeBadge(e, { compact: true });
                const active = e.instanceId === m.activeId;
                return (
                  <li key={e.sessionId} className="group/row relative" data-strip-entry={e.sessionId}>
                    <button
                      type="button"
                      onClick={() => selectInstance(e.instanceId, { userGesture: true })}
                      title={`${e.label}\n${reason}`}
                      aria-label={`${e.label} — ${reason}${badge ? ` — ${autoResumeBadge(e)?.text}` : ''}`}
                      style={ownerStyle(e.conductor ? e.sessionId : null)}
                      data-active={active || undefined}
                      data-unread={unread || undefined}
                      className={cn(
                        'flex h-7 w-full items-center gap-2 rounded-md pr-7 pl-2 text-left text-[13px] transition-colors hover:bg-sidebar-accent md:h-6',
                        e.conductor && OWNER_BAR,
                        active && 'bg-sidebar-accent ring-1 ring-border',
                        // Selection is the fill and ring above; weight marks unread only (docs/features.md → Selected session).
                        unread && 'font-semibold',
                      )}
                    >
                      <Dot
                        status={e.status}
                        awaitingWake={e.awaitingWake}
                        waitingOnJob={e.waitingOnJob}
                        awaitingUser={e.awaitingUser}
                        awaitingUserSource={e.awaitingUserSource}
                        unreadRing={unread}
                      />
                      <span className="min-w-[2em] flex-1 truncate" data-strip-label>{e.label}</span>
                      {badge && <span className="max-w-24 shrink truncate text-[11px] text-warning" title={badge.title} data-resume-badge>{badge.text}</span>}
                    </button>
                    <span className="absolute top-1/2 right-1 -translate-y-1/2">
                      <CloseButton args={{
                        projectName: e.projectName, worktreeName: e.worktreeName, sessionId: e.sessionId, instanceId: e.instanceId,
                        status: e.status, temp: e.temp, preview: e.label, synthetic: e.synthetic,
                      }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
