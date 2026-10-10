import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';
import { LoaderCircleIcon } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { uiStore } from '@/app/ui';
import { themeStore } from '@/app/theme';
import { ConfirmHost } from '@/ui/feedback';
import { AppSidebar } from '@/features/sidebar/AppSidebar';
import { SessionView } from '@/features/session/SessionView';
import { PluginView } from '@/features/views/PluginView';
import { DialogsHost } from '@/features/dialogs/DialogsHost';

// Full-page views load on first use; the session view is the app's landing page.
const SettingsView = lazy(() => import('@/features/settings/SettingsView').then((m) => ({ default: m.SettingsView })));
const ReviewView = lazy(() => import('@/features/views/ReviewView').then((m) => ({ default: m.ReviewView })));
const CommitsView = lazy(() => import('@/features/views/CommitsView').then((m) => ({ default: m.CommitsView })));
const CostsView = lazy(() => import('@/features/views/CostsView').then((m) => ({ default: m.CostsView })));

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
    case 'plugin': return null; // PluginView stays mounted below (keep-alive frames)
    default: return <SessionView />;
  }
}

export function App() {
  const sidebarOpen = useStore(uiStore, (s) => s.sidebarOpen);
  const theme = useStore(themeStore, (s) => s.resolved);
  const route = useRoute();
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <div className="hidden shrink-0 md:flex">
          <AppSidebar />
        </div>
        <Sheet open={sidebarOpen} onOpenChange={(o) => uiStore.set({ sidebarOpen: o })}>
          <SheetContent side="left" className="w-[88%] max-w-sm gap-0 p-0 md:hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <AppSidebar mobile />
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 flex-1">
          <Suspense fallback={<ViewFallback />}>
            <MainView />
          </Suspense>
          <PluginView active={route.view === 'plugin'} />
        </div>
      </div>
      <DialogsHost />
      <ConfirmHost />
      <Toaster theme={theme} position="top-right" richColors closeButton />
    </TooltipProvider>
  );
}
