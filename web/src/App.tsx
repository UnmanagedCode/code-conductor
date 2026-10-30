import { lazy, Suspense } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { uiStore } from '@/app/ui';
import { themeStore } from '@/app/theme';
import { ConfirmHost, ToastHost } from '@/ui/feedback';
import { TOAST_EDGE_GAP } from '@/ui/toastLayout';
import { AppSidebar } from '@/features/sidebar/AppSidebar';
import { SessionView } from '@/features/session/SessionView';
import { PluginView } from '@/features/views/PluginView';
import { dockModeStore } from '@/features/views/dock';
import { DialogsHost } from '@/features/dialogs/DialogsHost';
import { focusContent } from '@/lib/modalFocus';

// Full-page views load on first use; the session view is the app's landing page.
const SettingsView = lazy(() => import('@/features/settings/SettingsView').then((m) => ({ default: m.SettingsView })));
const ReviewView = lazy(() => import('@/features/views/ReviewView').then((m) => ({ default: m.ReviewView })));
const CommitsView = lazy(() => import('@/features/views/CommitsView').then((m) => ({ default: m.CommitsView })));
const CostsView = lazy(() => import('@/features/views/CostsView').then((m) => ({ default: m.CostsView })));

// Toasts sit below the views' top bar at every width, so none covers its controls.
const TOAST_OFFSET = { top: 'calc(env(safe-area-inset-top, 0px) + var(--header-height) + 0.5rem)' };
// On desktop toasts keep TOAST_EDGE_GAP from the window's edge.
const TOAST_OFFSET_DESKTOP = { ...TOAST_OFFSET, right: `${TOAST_EDGE_GAP}px` };

function ViewFallback() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircleIcon className="size-5 animate-spin" />
    </div>
  );
}

function MainView() {
  const route = useRoute();
  switch (route.view) {
    case 'settings': return <SettingsView />;
    case 'review': return <ReviewView />;
    case 'commits': return <CommitsView />;
    case 'costs': return <CostsView />;
    case 'plugin': return null; // PluginView, the always-mounted column right of this slot, fills the row (keep-alive frames)
    default: return <SessionView />;
  }
}

export function App() {
  const sidebarOpen = useStore(uiStore, (s) => s.sidebarOpen);
  const theme = useStore(themeStore, (s) => s.resolved);
  const columnFull = useStore(dockModeStore, (s) => s.mode === 'full');
  return (
    <TooltipProvider delayDuration={400}>
      {/* Positioned: the backstop clip for an absolutely positioned box that no positioned pane or wrapper captures, so none can lengthen the page. */}
      <div className="relative flex h-dvh overflow-hidden bg-background">
        <div className="hidden shrink-0 md:flex">
          <AppSidebar />
        </div>
        <Sheet open={sidebarOpen} onOpenChange={(o) => uiStore.set({ sidebarOpen: o })}>
          <SheetContent side="left" className="w-[88%] max-w-sm gap-0 p-0 md:hidden" onOpenAutoFocus={focusContent}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <AppSidebar mobile />
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 flex-1">
          {/* Hidden, still mounted, while the plugin column fills the row (a split too narrow to fit shows over the session). */}
          <div className="contents" hidden={columnFull}>
            <Suspense fallback={<ViewFallback />}>
              <MainView />
            </Suspense>
          </div>
          <PluginView />
        </div>
      </div>
      <DialogsHost />
      <ConfirmHost />
      <ToastHost theme={theme} position="top-right" offset={TOAST_OFFSET_DESKTOP} mobileOffset={TOAST_OFFSET} richColors closeButton />
    </TooltipProvider>
  );
}
