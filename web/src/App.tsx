import { lazy, Suspense } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { useRoute } from '@/state/route';
import { uiStore } from '@/app/ui';
import { themeStore } from '@/app/theme';
import { ConfirmHost, ToastHost } from '@/ui/feedback';
import { ErrorBoundary, RegionFallback } from '@/ui/ErrorBoundary';
import { TOAST_EDGE_GAP } from '@/ui/toastLayout';
import { AppSidebar } from '@/features/sidebar/AppSidebar';
import { keepFilterEscape } from '@/features/sidebar/FilterBar';
import { SessionView } from '@/features/session/SessionView';
import { PluginView } from '@/features/views/PluginView';
import { dockModeStore } from '@/features/views/dock';
import { LazyDialogsHost } from '@/features/dialogs/LazyDialogsHost';
import { ResumeBanner } from '@/features/resume/ResumeBanner';
import { focusContent } from '@/lib/modalFocus';

// Full-page views load on first use; the session view is the app's landing page.
const SettingsView = lazy(() => import('@/features/settings/SettingsView').then((m) => ({ default: m.SettingsView })));
const ReviewView = lazy(() => import('@/features/views/ReviewView').then((m) => ({ default: m.ReviewView })));
const CommitsView = lazy(() => import('@/features/views/CommitsView').then((m) => ({ default: m.CommitsView })));
const CostsView = lazy(() => import('@/features/views/CostsView').then((m) => ({ default: m.CostsView })));

// Toasts sit below the views' top bar at every width, so none covers its controls.
// One height for the shell and the root crash fallback, so a crash page follows the soft keyboard as the shell does (app/viewport.ts).
const SHELL_HEIGHT = 'h-(--app-height)';

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

const sidebarFallback = (className?: string) => (error: Error, reset: () => void) => (
  <RegionFallback region="sidebar" error={error} onRetry={reset} className={className} />
);

/** The routed view, behind its own boundary: a crash or a failed chunk load shows here, and another view or session clears it. */
function MainPane() {
  const view = useRoute().view;
  const activeId = useStore(appStore, (s) => s.activeId);
  return (
    <ErrorBoundary resetKey={`${view} ${activeId ?? ''}`} fallback={(error, reset) => <RegionFallback region="main" error={error} onRetry={reset} />}>
      <Suspense fallback={<ViewFallback />}>
        <MainView />
      </Suspense>
    </ErrorBoundary>
  );
}

/** The last resort: a crash outside every region replaces the page, not blanks it. */
export function App() {
  return (
    <ErrorBoundary fallback={(error) => <RegionFallback region="app" error={error} retryLabel="Reload page" onRetry={() => location.reload()} className={SHELL_HEIGHT} />}>
      <AppShell />
    </ErrorBoundary>
  );
}

function AppShell() {
  const sidebarOpen = useStore(uiStore, (s) => s.sidebarOpen);
  const theme = useStore(themeStore, (s) => s.resolved);
  const columnFull = useStore(dockModeStore, (s) => s.mode === 'full');
  return (
    <TooltipProvider delayDuration={400}>
      {/* Positioned: the backstop clip for an absolutely positioned box that no positioned pane or wrapper captures, so none can lengthen the page. */}
      <div className={`relative flex ${SHELL_HEIGHT} overflow-hidden bg-background`}>
        <div className="hidden shrink-0 md:flex">
          <ErrorBoundary fallback={sidebarFallback('w-72 flex-none border-r border-sidebar-border bg-sidebar')}>
            <AppSidebar />
          </ErrorBoundary>
        </div>
        <Sheet open={sidebarOpen} onOpenChange={(o) => uiStore.set({ sidebarOpen: o })}>
          <SheetContent side="left" className="w-[88%] max-w-sm gap-0 p-0 md:hidden" onOpenAutoFocus={focusContent} onEscapeKeyDown={keepFilterEscape}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <ErrorBoundary fallback={sidebarFallback()}>
              <AppSidebar mobile />
            </ErrorBoundary>
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 flex-1 flex-col">
          <ResumeBanner />
          <div className="flex min-h-0 min-w-0 flex-1">
            {/* Hidden, still mounted, while the plugin column fills the row (a split too narrow to fit shows over the session). */}
            <div className="contents" hidden={columnFull}>
              <MainPane />
            </div>
            <PluginView />
          </div>
        </div>
      </div>
      <LazyDialogsHost />
      <ConfirmHost />
      <ToastHost theme={theme} position="top-right" offset={TOAST_OFFSET_DESKTOP} mobileOffset={TOAST_OFFSET} richColors closeButton />
    </TooltipProvider>
  );
}
