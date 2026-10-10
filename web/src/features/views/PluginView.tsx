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
import { overlayStore, pluginFrames, refreshCatalog } from './plugins';
import { cn } from '@/lib/utils';

export function PluginView({ active }: { active: boolean }) {
  const route = useRoute();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const overlay = useStore(overlayStore, (s) => s.overlay);
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
    <section className={cn('relative min-w-0 flex-1 bg-background', !active && 'hidden')} aria-hidden={!active} data-view="plugin">
      <div ref={hostRef} className="absolute inset-0" />
      <Button
        variant="secondary"
        size="icon-sm"
        className="absolute top-[calc(env(safe-area-inset-top,0px)+0.5rem)] left-2 z-10 shadow-md md:hidden"
        aria-label="Open sidebar"
        onClick={() => uiStore.set({ sidebarOpen: true })}
      >
        <MenuIcon />
      </Button>
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
    </section>
  );
}
