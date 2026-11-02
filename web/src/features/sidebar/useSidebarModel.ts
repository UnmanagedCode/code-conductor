import * as React from 'react';
import { useSignal, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { deriveConductors, liveDirectOwnerOf, ownersByPlace, ownerLabel } from '@shared/conductors';
import { unreadBySession } from '@shared/unreadMarks';
import { filterOptions, partitionInstances, type SessionItem } from './derive';
import { sessionsCache, sessionsSignal } from './state';

/** Everything the sidebar's lists derive from the app's data, computed once per change. */
export function useSidebarModel() {
  const projects = useStore(appStore, (s) => s.projects);
  const workspaces = useStore(appStore, (s) => s.workspaces);
  const instances = useStore(appStore, (s) => s.instances);
  const conductRows = useStore(appStore, (s) => s.conductSessions);
  const spawns = useStore(appStore, (s) => s.conductorSpawns);
  const activeId = useStore(appStore, (s) => s.activeId);
  const cacheVersion = useSignal(sessionsSignal);

  return React.useMemo(() => {
    const conductors = deriveConductors({ conductRows, instances });
    const registered = new Set(projects.map((p) => p.name));
    const unread = unreadBySession({
      instances,
      rows: [...conductRows, ...[...sessionsCache.values()].flat()],
    });
    // Root owners scope the conductor filter; direct owners (a live section lead over its lead) colour the rows and worktree heads.
    const owners = ownersByPlace(instances, (i) => i.ownerSessionId ?? null);
    const barOwners = ownersByPlace(instances, (i) => liveDirectOwnerOf(i, instances));
    const byId = new Map(instances.map((i) => [i.id, i]));
    /** A session row's direct owner, from its live instance; a disk-only row has none. */
    const rowOwner = (s: SessionItem): string | null => {
      const inst = s.instanceId ? byId.get(s.instanceId) : undefined;
      return inst ? liveDirectOwnerOf(inst, instances) : null;
    };
    const { directByProject, byWorktree } = partitionInstances(instances);
    const options = filterOptions({ conductors, instances, spawns, registered });
    const ownerTitle = (sid: string) => ownerLabel(sid, { conductors, instances });
    return {
      projects, workspaces, instances, conductRows, spawns, activeId,
      conductors, registered, unread, owners, barOwners, rowOwner, directByProject, byWorktree, options, ownerTitle, cacheVersion,
    };
  }, [projects, workspaces, instances, conductRows, spawns, activeId, cacheVersion]);
}

export type SidebarModel = ReturnType<typeof useSidebarModel>;
