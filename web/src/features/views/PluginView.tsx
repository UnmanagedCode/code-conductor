// The plugin column, mounted for the app's lifetime right of the main view so
// keep-alive frames survive and no mode change moves a frame. Its width is its
// mode (dockLayout.ts): hidden, a split beside the session, or the whole row —
// the full view (`#plugin/<id>/<subpath>`), or a split too narrow to fit. Its
// bar carries the plugin's name and the one full ⇄ split toggle.
import * as React from 'react';
import { LoaderCircleIcon, Maximize2Icon, MenuIcon, PanelRightIcon, PlugIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSignal, useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { closeSidebarOnMobile, uiStore } from '@/app/ui';
import { pluginsChangedSignal, pluginsChangeStore } from '@/features/settings/pluginsSignal';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';
import { useResizableWidth } from '@/lib/useResizableWidth';
import { leaveView, useEscapeToClose } from './ViewShell';
import { appLabel, catalogStore, hashMirror, overlayStore, pluginFrames, refreshCatalog } from './plugins';
import { DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, dockLayout, maxPanel } from './dockLayout';
import { closeDock, DOCK_WIDTH_STORAGE_KEY, dockFullStore, dockFullView, dockMirror, dockStore, expandDock } from './dock';
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

const TOGGLES = {
  dock: { label: 'Dock to side', icon: <PanelRightIcon />, onClick: dockFullView },
  expand: { label: 'Expand to full view', icon: <Maximize2Icon />, onClick: expandDock },
} as const;

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
  // The default release commits the clamped width and the default toggle (double-click, Enter) resets to the default width.
  const { width, live, handleProps } = useResizableWidth({
    storageKey: DOCK_WIDTH_STORAGE_KEY,
    min: DOCK_PANEL_MIN_WIDTH,
    max: maxPanel(room),
    defaultWidth: DOCK_PANEL_DEFAULT_WIDTH,
    edge: 'left',
    label: 'Resize plugin dock',
  });
  const { mode, shownId, toggle } = dockLayout({
    desktop, view: route.view, routePluginId: route.pluginId, catalogIds, dockId: dock.id, available,
  });
  const routeFull = route.view === 'plugin';
  const shown = mode !== 'hidden';
  const title = shownId ? appLabel(apps.find((a) => a.id === shownId) ?? { name: shownId }) : '';
  // The full view steps back; a split shown full closes with no history step; split ignores Escape.
  useEscapeToClose(mode === 'full', routeFull ? leaveView : closeDock);

  React.useLayoutEffect(() => {
    dockFullStore.set({ full: mode === 'full' });
    return () => dockFullStore.set({ full: false });
  }, [mode]);

  React.useLayoutEffect(() => {
    pluginFrames.attach(hostRef.current);
    return () => pluginFrames.attach(null);
  }, []);

  const subpath = routeFull ? `/${route.pluginPath}` : dock.subpath;
  React.useEffect(() => {
    if (!shownId) {
      pluginFrames.leave();
      return;
    }
    pluginFrames.enter({ id: shownId, subpath }, routeFull ? hashMirror : dockMirror);
    if (routeFull) closeSidebarOnMobile();
  }, [shownId, subpath, routeFull]);

  // A Settings → Plugins action: refresh the switcher's catalog and evict stale resident frames.
  React.useEffect(() => {
    if (pluginsRev === 0) return;
    void refreshCatalog();
    void pluginFrames.reconcile(pluginsChangeStore.get().lastChange);
  }, [pluginsRev]);

  const t = toggle ? TOGGLES[toggle] : null;
  return (
    <div
      ref={columnRef}
      className={cn('relative flex min-w-0', mode === 'full' ? 'flex-1' : 'shrink-0', mode === 'hidden' && 'hidden')}
      style={mode === 'split' ? { width: live ?? width } : undefined}
      data-plugin-column
      data-dock-mode={mode}
    >
      {mode === 'split' && (
        <div
          {...handleProps}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 data-[active=true]:bg-primary/30"
          data-resize-handle="plugin-dock"
        />
      )}
      <section className={cn('relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background', mode === 'split' && 'border-l', !shown && 'hidden')} aria-hidden={!shown} data-view="plugin">
        {/* The column's bar, above the plugin's page and never over it. */}
        <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur">
          {!desktop && (
            <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => uiStore.set({ sidebarOpen: true })}>
              <MenuIcon />
            </Button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
          {t && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label={t.label} onClick={t.onClick}>
                  {t.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t.label}</TooltipContent>
            </Tooltip>
          )}
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
    </div>
  );
}
