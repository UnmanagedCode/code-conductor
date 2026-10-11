// Sidebar header switcher between Code Conductor and plugin frontends.
// Renders nothing until an enabled plugin contributes a frontend. A plugin with
// a resident (keep-alive) frame is labelled "(running)": its page keeps going —
// possibly with the microphone open — while you're elsewhere.
import * as React from 'react';
import { ChevronsUpDownIcon, PlugIcon } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OctopusMark } from '@/components/mascot/Octopus';
import { useSignal, useStore } from '@/state/createStore';
import { appStore, activeInstance } from '@/state/app';
import { syncRoute, useRoute } from '@/state/route';
import { writeSessionAnchor } from '@/lib/core/anchor.js';
import { closeSidebarOnMobile } from '@/app/ui';
import { pluginsChangedSignal } from '@/features/settings/pluginsSignal';
import { openPlugin } from './api';
import { catalogStore, pluginFrames, refreshCatalog, residentSignal, RESIDENT_SUFFIX } from './plugins';

/** The Conductor entry's value in the switcher's radio group; no plugin id is empty. */
const CONDUCTOR = '';

/** Back to Conductor: the active session's anchor, never history.back() (no usable entry on a deep link). */
export function exitToConductor() {
  writeSessionAnchor(activeInstance(appStore.get())?.sessionId ?? null);
  syncRoute();
  closeSidebarOnMobile();
}

/** The sidebar title; becomes the Conductor ↔ plugin dropdown once a plugin contributes a frontend. */
export function AppSwitcher({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) {
  const apps = useStore(catalogStore, (s) => s.apps);
  const route = useRoute();
  useSignal(residentSignal);
  const pluginsRev = useSignal(pluginsChangedSignal);
  React.useEffect(() => { void refreshCatalog(); }, [pluginsRev]);

  if (!apps.length) {
    return (
      <div className="ml-1 min-w-0 flex-1 leading-tight">
        <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>}
      </div>
    );
  }
  const currentId = route.view === 'plugin' ? route.pluginId : null;
  const current = apps.find((p) => p.id === currentId) ?? null;
  const live = new Set(pluginFrames.residentIds());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left leading-tight outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring"
        aria-label="Switch app"
        data-app-switcher
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold tracking-tight">{current ? current.navLabel || current.name : title}</span>
          {subtitle && <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>}
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Apps</DropdownMenuLabel>
        {/* The current app is the checked entry (Conductor while the route names no listed plugin). Picking the open plugin, or Conductor from Conductor, changes nothing; picking Conductor while the route names an unlisted plugin leaves its view. */}
        <DropdownMenuRadioGroup value={current?.id ?? CONDUCTOR}>
          <DropdownMenuRadioItem value={CONDUCTOR} onSelect={() => { if (currentId) exitToConductor(); }}>
            <OctopusMark className="size-4 text-primary" />
            <span className="flex-1">Conductor</span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {apps.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id} onSelect={() => { if (currentId !== p.id) openPlugin(p.id); }} data-app-id={p.id}>
              <PlugIcon />
              <span className="flex-1 truncate">{(p.navLabel || p.name) + (live.has(p.id) ? RESIDENT_SUFFIX : '')}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
