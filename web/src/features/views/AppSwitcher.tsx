// The switcher between Code Conductor and plugin frontends. One shows at a time,
// in the slot switcherSlot names for the column's mode (dockModeStore) and the
// breakpoint: the plugin column's bar while it shows a plugin at split or full
// width, else the desktop sidebar's or the phone drawer's header. Every other slot,
// and every slot until an enabled plugin contributes a frontend, renders its plain
// title. A plugin with a resident (keep-alive) frame is labelled "(running)": its
// page keeps going — possibly with the microphone open — while you're elsewhere.
import * as React from 'react';
import { ChevronsUpDownIcon, PlugIcon } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OctopusMark } from '@/components/mascot/Octopus';
import { useSignal, useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { closeSidebarOnMobile } from '@/app/ui';
import { pluginsChangedSignal } from '@/features/settings/pluginsSignal';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { appLabel, catalogStore, pluginFrames, refreshCatalog, residentSignal, RESIDENT_SUFFIX } from './plugins';
import { shownApp, switcherSlot, type SwitcherSlot } from './dockLayout';
import { closeDock, dockModeStore, dockStore, selectApp } from './dock';
import { showActiveSession } from './ViewShell';

/** The Conductor entry's value in the switcher's radio group; no plugin id is empty. */
const CONDUCTOR = '';

/** Back to Conductor: no plugin in split, and the active session. */
export function exitToConductor() {
  closeDock();
  showActiveSession();
  closeSidebarOnMobile();
}

/** The Conductor ↔ plugin dropdown in `slot` while it is the one switcher's slot and a plugin contributes a frontend, else `fallback` (the slot's plain title). */
export function AppSwitcher({ slot, title, subtitle, fallback, className }: {
  slot: SwitcherSlot; title: string; subtitle?: React.ReactNode; fallback: React.ReactNode; className?: string;
}) {
  const apps = useStore(catalogStore, (s) => s.apps);
  const route = useRoute();
  const dockId = useStore(dockStore, (s) => s.id);
  const mode = useStore(dockModeStore, (s) => s.mode);
  const desktop = useMediaQuery(WIDE_QUERY);
  useSignal(residentSignal);
  const pluginsRev = useSignal(pluginsChangedSignal);
  // The sidebar copies read the catalog; PluginView refreshes it for the bar's.
  React.useEffect(() => { if (slot !== 'pane') void refreshCatalog(); }, [pluginsRev, slot]);

  if (!apps.length || switcherSlot(mode, desktop) !== slot) return <>{fallback}</>;
  const currentId = shownApp({ desktop, view: route.view, routePluginId: route.pluginId, catalogIds: apps.map((p) => p.id), dockId });
  const current = apps.find((p) => p.id === currentId) ?? null;
  const live = new Set(pluginFrames.residentIds());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left leading-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring', className)}
        aria-label="Switch app"
        data-app-switcher
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold tracking-tight">{current ? appLabel(current) : title}</span>
          {subtitle && <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>}
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Apps</DropdownMenuLabel>
        {/* The checked entry is the plugin on screen, full or split (Conductor while none, or the route names an unlisted plugin). Picking the shown plugin, or Conductor from Conductor, changes nothing; picking Conductor while the route names an unlisted plugin leaves its view. */}
        <DropdownMenuRadioGroup value={current?.id ?? CONDUCTOR}>
          <DropdownMenuRadioItem value={CONDUCTOR} onSelect={() => { if (currentId) exitToConductor(); }}>
            <OctopusMark className="size-4 text-primary" />
            <span className="flex-1">Conductor</span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {apps.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id} onSelect={() => { if (currentId !== p.id) selectApp(p.id, desktop); }} data-app-id={p.id}>
              <PlugIcon />
              <span className="flex-1 truncate">{appLabel(p) + (live.has(p.id) ? RESIDENT_SUFFIX : '')}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
