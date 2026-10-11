// The conductor filter falls back to All as soon as its owner is no longer
// offered (no live session and no registered idle chip), whichever lens shows:
// a filter nothing offers is one nothing can clear.
import { appStore } from '@/state/app';
import { deriveConductors } from './core';
import { filterOptions, filterOwner } from './derive';
import { setFilter, sidebarStore } from './state';

function fallBack() {
  const owner = filterOwner(sidebarStore.get().filter);
  if (!owner) return;
  const { projects, instances, conductSessions, conductorSpawns } = appStore.get();
  const conductors = deriveConductors({ conductRows: conductSessions, instances });
  const registered = new Set(projects.map((p) => p.name));
  const options = filterOptions({ conductors, instances, spawns: conductorSpawns, registered });
  if (!options.some((o) => o.value === owner)) setFilter('');
}

appStore.subscribe(fallBack);
sidebarStore.subscribe(fallBack);
