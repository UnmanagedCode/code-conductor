// Reveal on select: every selection opens the groups that hold the session in
// both lenses (workspace, Worktrees, Sessions subnode, conductor bubble,
// Inactive) and switches a filter that hides it — once per selection, so a
// group the user collapses afterwards stays collapsed. A selection whose
// instance isn't listed yet (a resume in flight) is revealed when it appears.
import { appStore } from '@/state/app';
import { on } from '@/app/events';
import { deriveConductors } from './core';
import { revealTarget } from './derive';
import { setConductorOpen, setFilter, setSessionsOpen, setWorkspaceOpen, setWorktreesOpen, sidebarStore } from './state';

let lastActive: string | null = null;
let pending: string | null = null;

/** Scrolls every selected row under `root` into view. */
export function scrollActiveIntoView(root: ParentNode) {
  for (const el of root.querySelectorAll('[data-active="true"]')) {
    (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
  }
}

let frame = 0;
/** One scroll per frame however many reveals ask for it: a selection reveals through both arms. */
function scheduleScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    scrollActiveIntoView(document);
  });
}

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
  scheduleScroll();
}

appStore.subscribe(tryReveal);

// A selection reveals even when it names the selected session: a click on the
// selected row or its strip entry re-opens what the user collapsed on its path.
on('select', ({ id }) => {
  lastActive = id;
  pending = id;
  tryReveal();
});
