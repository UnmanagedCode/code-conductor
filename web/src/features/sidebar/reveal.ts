// Reveal on select: every selection opens the groups that hold the session in
// both lenses (workspace, Worktrees, Sessions subnode, conductor bubble,
// Inactive) and switches a filter that hides it — once per selection, so a
// group the user collapses afterwards stays collapsed. A selection whose
// instance isn't listed yet (a resume in flight) is revealed when it appears.
import { appStore } from '@/state/app';
import { deriveConductors } from './core';
import { revealTarget } from './derive';
import { setConductorOpen, setFilter, setSessionsOpen, setWorkspaceOpen, setWorktreesOpen, sidebarStore } from './state';

let lastActive: string | null = null;
let pending: string | null = null;

function tryReveal() {
  const { activeId, instances, projects, conductSessions } = appStore.get();
  if (activeId !== lastActive) {
    lastActive = activeId;
    pending = activeId;
  }
  if (!pending) return;
  const inst = instances.find((i) => i.id === pending);
  if (!inst) return;
  pending = null;
  const conductors = deriveConductors({ conductRows: conductSessions, instances });
  const t = revealTarget({ inst, projects, conductors, filter: sidebarStore.get().filter });
  if (t.workspace) setWorkspaceOpen(t.workspace, true);
  if (t.worktreesOf) setWorktreesOpen(t.worktreesOf, true);
  if (t.sessionsKey) setSessionsOpen(t.sessionsKey, true);
  if (t.conductor) setConductorOpen(t.conductor, true);
  if (t.inactive) sidebarStore.set({ inactiveOpen: true });
  if (t.filter != null) setFilter(t.filter);
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll('[data-active="true"]')) {
      (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
    }
  });
}

appStore.subscribe(tryReveal);
