import * as React from 'react';
import { ArrowLeftIcon, MenuIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { appStore, activeInstance } from '@/state/app';
import { closeView, syncRoute } from '@/state/route';
import { writeSessionAnchor } from '@shared/anchor';
import { uiStore } from '@/app/ui';
import { useSessionColumn } from '@/app/sessionWidth';
import { cn } from '@/lib/utils';

/** Leave the full-page view: back where the user came from, else to the active session. */
export function leaveView() {
  closeView(activeInstance(appStore.get())?.sessionId ?? null);
}

/** Show the active session by writing its anchor, never history.back(): no entry beneath is known to be the session's (a deep link, a stacked view). */
export function showActiveSession() {
  writeSessionAnchor(activeInstance(appStore.get())?.sessionId ?? null);
  syncRoute();
}

/** Escape runs `onClose` (default: leave the view), unless a dialog or menu is open (it closes those first). */
export function useEscapeToClose(enabled = true, onClose: () => void = leaveView) {
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [enabled, onClose]);
}

/** The frame every full-page view shares: back button, title, stats, actions, scrolling body. */
export function ViewShell({
  title, subtitle, icon, actions, children, className, ...rest
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  useEscapeToClose();
  const column = useSessionColumn({ gutter: false });
  return (
    <main className="flex min-w-0 flex-1 flex-col" {...rest}>
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-10 flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 py-2 backdrop-blur md:px-5">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open sidebar" onClick={() => uiStore.set({ sidebarOpen: true })}>
          <MenuIcon />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={leaveView} data-view-back>
              <ArrowLeftIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-1.5">Back <Kbd className="bg-background/20 text-background">Esc</Kbd></TooltipContent>
        </Tooltip>
        {icon && <span className="hidden text-muted-foreground sm:inline-flex">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {subtitle && <div className="truncate text-xs text-muted-foreground tabular-nums">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      {/* Positioned: an absolutely positioned descendant (Radix's hidden form input) stays in this pane and scrolls with it instead of extending the page. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div {...column} className={cn('@container mx-auto w-full px-3 py-5 md:px-6 md:py-8', className)}>{children}</div>
      </div>
    </main>
  );
}

export function ViewMessage({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-xl border border-dashed px-4 py-10 text-center text-sm', tone === 'error' ? 'border-destructive/40 text-destructive' : 'text-muted-foreground')}>
      {children}
    </div>
  );
}
