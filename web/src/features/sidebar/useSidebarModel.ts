import * as React from 'react';
import { useSignal, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { deriveConductors, ownersByPlace, ownerLabel, unreadBySession } from './core';
import { filterOptions, partitionInstances } from './derive';
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
    const owners = ownersByPlace(instances);
    const { directByProject, byWorktree } = partitionInstances(instances);
    const options = filterOptions({ conductors, instances, spawns, registered });
    const ownerTitle = (sid: string) => ownerLabel(sid, { conductors, instances });
    return {
      projects, workspaces, instances, conductRows, spawns, activeId,
      conductors, registered, unread, owners, directByProject, byWorktree, options, ownerTitle, cacheVersion,
    };
  }, [projects, workspaces, instances, conductRows, spawns, activeId, cacheVersion]);
}

export type SidebarModel = ReturnType<typeof useSidebarModel>;
