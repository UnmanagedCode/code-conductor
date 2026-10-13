// The plugin column, mounted for the app's lifetime right of the main view so
// keep-alive frames survive and no mode change moves a frame. Its width is its
// mode (dockLayout.ts): hidden, the icon rail, a split beside the session, or
// the full view (`#plugin/<id>/<subpath>`).
import * as React from 'react';
import { LoaderCircleIcon, MenuIcon, PlugIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSignal, useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { closeSidebarOnMobile, uiStore } from '@/app/ui';
import { pluginsChangedSignal, pluginsChangeStore } from '@/features/settings/pluginsSignal';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';
import { useResizableWidth } from '@/lib/useResizableWidth';
import { useEscapeToClose } from './ViewShell';
import { appLabel, catalogStore, overlayStore, pluginFrames, refreshCatalog } from './plugins';
import {
  canSplit, DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_RAIL_WIDTH, dockLayout, dockTarget, fits, maxPanel, releaseDecision,
} from './dockLayout';
import {
  collapseDock, DOCK_WIDTH_STORAGE_KEY, dockMirror, dockStore, expandApp, expandDocked, fullMirror, openDock, railStore,
} from './dock';
import { PluginRail } from './PluginRail';
import { cn } from '@/lib/utils';

/** The main row's content width, from its ResizeObserver; null until the first measurement. */
function useAvailableWidth(ref: React.RefObject<HTMLElement | null>) {
  const [available, setAvailable] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    const ro = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setAvailable(last.contentRect.width);
    });
    ro.observe(row);
    return () => ro.disconnect();
  }, [ref]);
  return available;
}

export function PluginView() {
  const route = useRoute();
  const columnRef = React.useRef<HTMLDivElement>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const overlay = useStore(overlayStore, (s) => s.overlay);
  const apps = useStore(catalogStore, (s) => s.apps);
  const catalogIds = React.useMemo(() => apps.map((a) => a.id), [apps]);
  const dock = useStore(dockStore, (s) => s);
  const desktop = useMediaQuery(WIDE_QUERY);
  const available = useAvailableWidth(columnRef);
  const pluginsRev = useSignal(pluginsChangedSignal);

  // Before the first measurement the window bounds the handle (the layout still treats null as fitting).
  const room = available ?? window.innerWidth;
  // Opened from a rail the stored width no longer fits: split shows at the widest width that does, and the stored width stays the preference.
  const [squeezed, setSqueezed] = React.useState(false);
  const layoutAt = (width: number, dragging: boolean) => dockLayout({
    desktop, view: route.view, routePluginId: route.pluginId, catalogIds, dock, width, available, dragging,
  });
  const target = dockTarget(dock.id, catalogIds);
  /** A rail open: split, squeezed when the stored width does not fit; the full view when no split fits. Writes no width. */
  const openFromRail = (id: string) => {
    if (!canSplit(available)) { expandApp(id); return; }
    openDock(id);
    setSqueezed(!fits(preferred, available));
  };
  const { preferred, width, live, handleProps } = useResizableWidth({
    storageKey: DOCK_WIDTH_STORAGE_KEY,
    min: DOCK_PANEL_MIN_WIDTH,
    max: maxPanel(room),
    defaultWidth: DOCK_PANEL_DEFAULT_WIDTH,
    edge: 'left',
    label: 'Resize plugin dock',
    collapsible: true,
    collapsed: (w) => layoutAt(squeezed ? w.width : w.preferred, false).mode === 'rail',
    onRelease: (raw) => {
      if (!target) return false;
      switch (releaseDecision(raw, room)) {
        case 'rail':
          collapseDock();
          return false;
        case 'full':
          if (!dock.open || dock.id !== target) openDock(target);
          expandDocked();
          return false;
        case 'width':
          openDock(target);
          return true;
      }
    },
    onToggle: () => {
      if (mode === 'split') collapseDock();
      else if (target) openFromRail(target);
    },
  });
  // A drag's own width always fits (it is clamped to the room left); otherwise the preferred width decides, or the shown one while squeezed.
  const { mode, shownId, railShown } = layoutAt(live ?? (squeezed ? width : preferred), live !== null);
  // The squeeze ends with the dock closing or the stored width fitting again (a later narrowing then collapses to the rail).
  const unsqueeze = squeezed && (!dock.open || fits(preferred, available));
  React.useEffect(() => { if (unsqueeze) setSqueezed(false); }, [unsqueeze]);
  // Nothing shown: the rail marks the docked app, which a rail open reopens.
  const markedId = shownId ?? (dock.id !== null && catalogIds.includes(dock.id) ? dock.id : null);
  const shown = mode === 'split' || mode === 'full';
  const panelWidth = live ?? width;
  const title = shownId ? appLabel(apps.find((a) => a.id === shownId) ?? { name: shownId }) : '';
  useEscapeToClose(mode === 'full');

  React.useLayoutEffect(() => {
    railStore.set({ shown: railShown });
    return () => railStore.set({ shown: false });
  }, [railShown]);

  React.useLayoutEffect(() => {
    pluginFrames.attach(hostRef.current);
    return () => pluginFrames.attach(null);
  }, []);

  const subpath = mode === 'full' ? `/${route.pluginPath}` : dock.subpath;
  React.useEffect(() => {
    if (!shownId) {
      pluginFrames.leave();
      return;
    }
    pluginFrames.enter({ id: shownId, subpath }, mode === 'full' ? fullMirror : dockMirror);
    if (mode === 'full') closeSidebarOnMobile();
  }, [shownId, subpath, mode]);

  // A Settings → Plugins action: refresh the switcher's catalog and evict stale resident frames.
  React.useEffect(() => {
    if (pluginsRev === 0) return;
    void refreshCatalog();
    void pluginFrames.reconcile(pluginsChangeStore.get().lastChange);
  }, [pluginsRev]);

  return (
    <div
      ref={columnRef}
      className={cn('relative flex min-w-0', mode === 'full' ? 'flex-1' : 'shrink-0', mode === 'hidden' && 'hidden')}
      style={mode === 'split' ? { width: panelWidth + DOCK_RAIL_WIDTH } : undefined}
      data-plugin-column
      data-dock-mode={mode}
    >
      {(mode === 'rail' || mode === 'split') && (
        <div
          {...handleProps}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 data-[active=true]:bg-primary/30"
          data-resize-handle="plugin-dock"
        />
      )}
      <section className={cn('relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background', mode === 'split' && 'border-l', !shown && 'hidden')} aria-hidden={!shown} data-view="plugin">
        <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => uiStore.set({ sidebarOpen: true })}>
            <MenuIcon />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
        </header>
        {/* Positioned: the frames and the start overlay fill the area below the bar. */}
        <div className="relative min-h-0 flex-1">
          {/* Never conditional and never re-parented: moving an iframe in the DOM reloads it. */}
          <div ref={hostRef} className="absolute inset-0" data-plugin-host />
          {overlay && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 p-6 backdrop-blur-sm" data-plugin-overlay>
              <div className="w-full max-w-lg space-y-4 text-center">
                {overlay.retry ? <PlugIcon className="mx-auto size-8 text-destructive" /> : <LoaderCircleIcon className="mx-auto size-8 animate-spin text-primary" />}
                <pre className={cn('max-h-80 overflow-auto text-left font-sans text-sm whitespace-pre-wrap', overlay.retry ? 'rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive' : 'text-center text-muted-foreground')}>
                  {overlay.message}
                </pre>
                {overlay.retry && (
                  <Button onClick={() => void pluginFrames.load(overlay.retry!)}><RotateCwIcon /> Retry</Button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
      {railShown && <PluginRail mode={mode} markedId={markedId} onOpen={openFromRail} />}
    </div>
  );
}
