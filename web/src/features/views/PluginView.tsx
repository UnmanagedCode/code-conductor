// Plugin frontends in same-origin iframes (`#plugin/<id>/<subpath>`). Mounted
// for the app's lifetime so keep-alive frames survive leaving the view.
import * as React from 'react';
import { LoaderCircleIcon, MenuIcon, PlugIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSignal, useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { closeSidebarOnMobile, uiStore } from '@/app/ui';
import { pluginsChangedSignal, pluginsChangeStore } from '@/features/settings/pluginsSignal';
import { useEscapeToClose } from './ViewShell';
import { appLabel, catalogStore, overlayStore, pluginFrames, refreshCatalog } from './plugins';
import { cn } from '@/lib/utils';

export function PluginView({ active }: { active: boolean }) {
  const route = useRoute();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const overlay = useStore(overlayStore, (s) => s.overlay);
  const title = useStore(catalogStore, (s) => {
    const row = s.apps.find((a) => a.id === route.pluginId);
    return row ? appLabel(row) : route.pluginId ?? '';
  });
  const pluginsRev = useSignal(pluginsChangedSignal);
  useEscapeToClose(active);

  React.useLayoutEffect(() => {
    pluginFrames.attach(hostRef.current);
    return () => pluginFrames.attach(null);
  }, []);

  const id = active ? route.pluginId : null;
  const subpath = `/${route.pluginPath}`;
  React.useEffect(() => {
    if (!id) {
      pluginFrames.leave();
      return;
    }
    pluginFrames.enter({ id, subpath });
    closeSidebarOnMobile();
  }, [id, subpath]);

  // A Settings → Plugins action: refresh the switcher's catalog and evict stale resident frames.
  React.useEffect(() => {
    if (pluginsRev === 0) return;
    void refreshCatalog();
    void pluginFrames.reconcile(pluginsChangeStore.get().lastChange);
  }, [pluginsRev]);

  return (
    <section className={cn('relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background', !active && 'hidden')} aria-hidden={!active} data-view="plugin">
      <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:hidden">
        <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => uiStore.set({ sidebarOpen: true })}>
          <MenuIcon />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
      </header>
      {/* Positioned: the frames and the start overlay fill the area below the bar. */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
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
  );
}
