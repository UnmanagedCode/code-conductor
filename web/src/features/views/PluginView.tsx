// The plugin column, mounted for the app's lifetime right of the main view so
// keep-alive frames survive and no mode change moves a frame. Its width is its
// mode (dockLayout.ts): hidden, a split beside the session, a rail, or the whole
// row — the full view (`#plugin/<id>/<subpath>`), or a split too narrow to fit.
// Its bar carries Collapse, the plugin's name, the one full ⇄ split toggle and Close plugin
// (the switcher's Conductor pick, which hides a keep-alive page and stops nothing).
import * as React from 'react';
import { LoaderCircleIcon, Maximize2Icon, MenuIcon, PanelRightCloseIcon, PanelRightIcon, PanelRightOpenIcon, PlugIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSignal, useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { closeSidebarOnMobile, uiStore } from '@/app/ui';
import { pluginsChangedSignal, pluginsChangeStore } from '@/features/settings/pluginsSignal';
import { useMediaQuery, WIDE_QUERY } from '@/lib/useMediaQuery';
import { RESIZE_HANDLE_CLASS, useResizableWidth } from '@/lib/useResizableWidth';
import { leaveView, useEscapeToClose } from './ViewShell';
import { exitToConductor } from './AppSwitcher';
import { appLabel, catalogStore, hashMirror, overlayStore, pluginFrames, refreshCatalog } from './plugins';
import { DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_RAIL_WIDTH, dockLayout, maxPanel } from './dockLayout';
import { closeDock, DOCK_WIDTH_STORAGE_KEY, dockCollapsedStore, dockFullStore, dockFullView, dockMirror, dockStore, expandDock, setDockCollapsed } from './dock';
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
  const collapsed = useStore(dockCollapsedStore, (s) => s.collapsed);
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
    desktop, view: route.view, routePluginId: route.pluginId, catalogIds, dockId: dock.id, available, collapsed,
  });
  const rail = mode === 'rail';
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

  // A keyboard activation hands focus to the control that replaces the pressed one; otherwise it would sit in the inert section.
  const focusAfter = React.useRef<'rail' | 'bar' | null>(null);
  const collapseRef = React.useRef<HTMLButtonElement>(null);
  const expandRef = React.useRef<HTMLButtonElement>(null);
  const collapse = (kb: boolean) => { focusAfter.current = kb ? 'rail' : null; setDockCollapsed(true); };
  const restore = (kb: boolean) => { focusAfter.current = kb ? 'bar' : null; setDockCollapsed(false); };
  React.useLayoutEffect(() => {
    const target = focusAfter.current === 'rail' ? expandRef.current : focusAfter.current === 'bar' ? collapseRef.current : null;
    target?.focus();
    focusAfter.current = null;
  }, [mode]);

  const t = toggle ? TOGGLES[toggle] : null;
  return (
    <div
      ref={columnRef}
      className={cn('relative flex min-w-0', mode === 'full' ? 'flex-1' : 'shrink-0', mode === 'hidden' && 'hidden', rail && 'overflow-clip')}
      style={mode === 'split' ? { width: live ?? width } : rail ? { width: DOCK_RAIL_WIDTH } : undefined}
      data-plugin-column
      data-dock-mode={mode}
    >
      {mode === 'split' && (
        <div
          {...handleProps}
          className={cn('absolute inset-y-0 -left-1 z-10', RESIZE_HANDLE_CLASS)}
          data-resize-handle="plugin-dock"
        />
      )}
      {rail && (
        <div className="flex w-full flex-col items-center border-l bg-background" data-dock-rail>
          <div className="flex h-(--header-height) shrink-0 items-center justify-center border-b">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button ref={expandRef} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Expand plugin dock" onClick={(e) => restore(e.detail === 0)}>
                  <PanelRightOpenIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Expand plugin dock</TooltipContent>
            </Tooltip>
          </div>
          <span className="min-h-0 truncate py-2 text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">{title}</span>
        </div>
      )}
      {/* In the rail the section stays laid out at the split width behind the clip, so its frames never resize or reload. */}
      <section
        className={cn('relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background', mode === 'split' && 'border-l', !shown && 'hidden', rail && 'invisible absolute inset-y-0 left-full')}
        style={rail ? { width } : undefined}
        aria-hidden={!shown || rail}
        inert={rail}
        data-view="plugin"
      >
        {/* The column's bar, above the plugin's page and never over it. */}
        <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur">
          {mode === 'split' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button ref={collapseRef} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Collapse plugin dock" onClick={(e) => collapse(e.detail === 0)}>
                  <PanelRightCloseIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Collapse plugin dock</TooltipContent>
            </Tooltip>
          )}
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
          {shownId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Close plugin" onClick={exitToConductor}>
                  <XIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close plugin</TooltipContent>
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
