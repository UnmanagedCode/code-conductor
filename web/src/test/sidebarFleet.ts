// The seeded fleet the sidebar's ownership, filter and reveal tests share: three
// conductors (A live and titled, B live and untitled, C dead with spawn history
// only), workers in a single-owner worktree, a mixed worktree and a main
// checkout, and hand-spawned sessions. Counts are asymmetric (A 5 workers, B 2,
// hand 3), so an inverted owner predicate cannot hide behind equal totals.
import { appStore } from '@/state/app';
import { conductorColor } from '@/lib/core/conductorColor.js';
import { OWNER_BAR } from '@/features/sidebar/rows';
import type { SidebarUi } from '@/features/sidebar/state';

export const A = 'cond-a';
export const B = 'cond-b';
export const C = 'cond-c';

export const COLOUR = { A: conductorColor(A), B: conductorColor(B), C: conductorColor(C) };
if (new Set(Object.values(COLOUR)).size !== 3) throw new Error('sidebarFleet: conductor colours must be distinct');

/** A's title. */
export const ALPHA = 'Alpha';
/** B's first prompt, and so its owner label. */
export const BRAVO = 'bravo: sweep the docs';

export const inst = (o: Record<string, any>): any => ({ id: `i-${o.sessionId}`, status: 'idle', mode: 'plan', ...o });
export const conductor = (sid: string, over: Record<string, any> = {}): any =>
  inst({ sessionId: sid, project: '.conduct', temp: true, ...over });
export const worker = (sid: string, owner: string, project: string, wt: string | null = null, over: Record<string, any> = {}): any =>
  inst({
    sessionId: sid, project, conducted: true, temp: true, ownerSessionId: owner,
    worktree: wt ? { worktreeName: wt } : null, firstPrompt: `${sid} prompt`, ...over,
  });
export const hand = (sid: string, project: string, wt: string | null = null, over: Record<string, any> = {}): any =>
  inst({
    sessionId: sid, project, conducted: false, temp: false, ownerSessionId: null,
    worktree: wt ? { worktreeName: wt } : null, firstPrompt: `${sid} prompt`, ...over,
  });
export const proj = (name: string, over: Record<string, any> = {}): any => ({
  name, path: `/p/${name}`, workspace: null, system: 'local', remoteId: null, isGitRepo: false, worktrees: [],
  sessions: { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 }, ...over,
});
export const wt = (name: string, over: Record<string, any> = {}): any => ({
  worktreeName: name, branch: `cc/${name}`, baseBranch: 'main', baseSha: 'deadbeef0000', sessions: { count: 0, lastActivity: 0 }, ...over,
});
export const disk = (sessionId: string, firstPrompt: string, over: Record<string, any> = {}): any => ({ sessionId, firstPrompt, lastActivity: 1, ...over });

export type Fleet = {
  projects: any[];
  workspaces: string[];
  instances: any[];
  conductSessions: any[];
  conductorSpawns: Record<string, { project: string; lastSpawnAt: number; worktrees?: string[] }[]>;
};

/** A fresh fleet on every call. Only `hand` has disk sessions, so every other list is live-only until a test adds rows. */
export function fleet(): Fleet {
  // Distinct, descending response times fix the row order.
  const instances = [
    conductor(A, { title: ALPHA }),
    conductor(B, { temp: false, firstPrompt: BRAVO }),
    worker('wa-solo1', A, 'solo', 'solo-a'),
    worker('wa-solo2', A, 'solo', 'solo-a'),
    worker('wa-mix', A, 'mixed', 'mix'),
    worker('wa-main1', A, 'main'),
    worker('wa-main2', A, 'main'),
    worker('wb-mix', B, 'mixed', 'mix'),
    worker('wb-main', B, 'main'),
    hand('h-solo', 'solo', 'solo-a'),
    hand('h-mix', 'mixed', 'mix'),
    hand('h-hand', 'hand'),
  ].map((i, n) => ({ ...i, lastResponseAt: 1000 - n }));
  return {
    projects: [
      proj('solo', { workspace: 'Acme', isGitRepo: true, worktrees: [wt('solo-a')] }),
      proj('mixed', { workspace: 'Acme', isGitRepo: true, worktrees: [wt('mix')] }),
      proj('main', { isGitRepo: true }),
      proj('hand', { sessions: { count: 2, archivedCount: 0, handCount: 2, lastActivity: 5 } }),
      proj('idle'),
    ],
    workspaces: ['Acme'],
    instances,
    conductSessions: [
      { sessionId: B, firstPrompt: BRAVO, lastActivity: 200 },
      { sessionId: C, firstPrompt: 'charlie: an old run', lastActivity: 50 },
    ],
    conductorSpawns: {
      [A]: [{ project: 'idle', lastSpawnAt: 2, worktrees: [] }],
      [C]: [{ project: 'idle', lastSpawnAt: 1, worktrees: [] }],
    },
  };
}

/** The groups the fleet's rows sit in, open: members of a closed workspace don't render. */
export const FLEET_UI: Pick<SidebarUi, 'expandedWorkspaces' | 'expandedWorktrees'> = {
  expandedWorkspaces: ['Acme'],
  expandedWorktrees: ['solo', 'mixed'],
};

export function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
    ...over,
  });
}

export const seedFleet = (f: Fleet, over: Partial<ReturnType<typeof appStore.get>> = {}) => seed({ ...f, ...over });

export const el = (sel: string) => document.querySelector(sel) as HTMLElement;
export const rowOf = (sid: string) => el(`[data-session-row="${sid}"] [role="button"]`);
export const labelOf = (sid: string) => rowOf(sid).querySelector('span.truncate') as HTMLElement;
export const headOf = (wtName: string) => el(`[data-worktree-row="${wtName}"]`);
export const projectRowOf = (name: string) => el(`[data-project-row="${name}"]`);
/** Whether `node` draws the owner bar, and in which colour. */
export const barOf = (node: HTMLElement): { bar: boolean; color: string } => ({
  bar: node.classList.contains(OWNER_BAR),
  color: node.style.getPropertyValue('--owner-color'),
});
export const NO_BAR = { bar: false, color: '' };

// Conductors lens and needs-you strip (card 2026-0629)
export const blockOf = (sid: string) => el(`[data-conductor="${sid}"]`);
export const conductorRowOf = (sid: string) => el(`[data-conductor="${sid}"] > [role="button"]`);
/** The row's label: its first span.truncate (the dot is no truncate span). */
export const conductorTitleOf = (sid: string) => conductorRowOf(sid).querySelector('span.truncate') as HTMLElement;
export const conductorDotOf = (sid: string) => conductorRowOf(sid).querySelector('[data-dot]') as HTMLElement;
export const stripEntryOf = (sid: string) => el(`[data-strip-entry="${sid}"] > button`);
