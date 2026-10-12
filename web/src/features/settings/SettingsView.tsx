import * as React from 'react';
import {
  ArchiveIcon, ArrowLeftIcon, CpuIcon, InfoIcon, KeyRoundIcon, LayersIcon, MenuIcon, MicIcon, PlugIcon, ScrollTextIcon, ServerIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/state/createStore';
import { appStore, activeInstance } from '@/state/app';
import { closeView, replaceHash, useRoute } from '@/state/route';
import { uiStore } from '@/app/ui';
import { loadCapabilities } from '@/lib/core/capabilities.js';
import { cn } from '@/lib/utils';
import { ModelsSection } from './models/ModelsSection';
import { loadModelsSettings } from './models/store';
import { BackendsSection } from './BackendsSection';
import { SystemsSection } from './SystemsSection';
import { AccountSection, discardOverageDraft } from './AccountSection';
import { VoiceSection } from './VoiceSection';
import { ConventionsSection, clearConventionsListErrors } from './ConventionsSection';
import { PluginsSection, resetPluginNotes } from './PluginsSection';
import { ArchivedSection } from './ArchivedSection';
import { AboutSection } from './AboutSection';
import { SECTION_CATALOG, offeredSections, type SectionCaps, type SectionId } from './sections';

const VIEWS: Record<SectionId, { icon: React.ComponentType<{ className?: string }>; render: () => React.ReactNode }> = {
  models: { icon: CpuIcon, render: () => <ModelsSection /> },
  conventions: { icon: ScrollTextIcon, render: () => <ConventionsSection /> },
  plugins: { icon: PlugIcon, render: () => <PluginsSection /> },
  backends: { icon: LayersIcon, render: () => <BackendsSection /> },
  systems: { icon: ServerIcon, render: () => <SystemsSection /> },
  account: { icon: KeyRoundIcon, render: () => <AccountSection /> },
  voice: { icon: MicIcon, render: () => <VoiceSection /> },
  archived: { icon: ArchiveIcon, render: () => <ArchivedSection /> },
  about: { icon: InfoIcon, render: () => <AboutSection /> },
};

/** SECTION_CATALOG (./sections.ts) with each section's icon and renderer. */
export const SECTIONS = SECTION_CATALOG.map((s) => ({ ...s, ...VIEWS[s.id] }));

/** The sections this platform offers: `offeredSections` over SECTIONS. */
export function visibleSections(caps: SectionCaps | null) {
  return offeredSections(SECTIONS, caps);
}

export function SettingsView() {
  const route = useRoute();
  const activeSid = useStore(appStore, (s) => activeInstance(s)?.sessionId ?? null);
  const [caps, setCaps] = React.useState<SectionCaps | null>(null);
  const [capsLoaded, setCapsLoaded] = React.useState(false);
  const sections = visibleSections(caps);
  const requested = (route.section as SectionId | null) ?? 'models';
  const current = sections.find((s) => s.id === requested) ?? sections[0];
  // An unapplied overage edit and its status are dropped before the section renders, so a stale status (a live region) and an enabled Apply never reach the DOM.
  // The write runs during render, so no overageDraftStore subscriber may be mounted yet: Settings must remount on entry, or React warns "Cannot update a component while rendering a different component".
  React.useState(discardOverageDraft);
  const navRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    void loadModelsSettings();
    clearConventionsListErrors();
    resetPluginNotes();
    loadCapabilities().then((c: any) => { setCaps(c); setCapsLoaded(true); });
  }, []);

  // A section this platform lacks (a stale link) lands on the first one.
  React.useEffect(() => {
    if (capsLoaded && route.section && current.id !== route.section) replaceHash(`#settings/${current.id}`);
  }, [capsLoaded, route.section, current.id]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"]')) return;
      closeView(activeSid);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [activeSid]);

  // Keep the active pill in view in the phone scroller.
  React.useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current.id]);

  // Wait for capabilities before rendering a gated section, so it is never fetched where unsupported.
  const showBody = !current.capability || capsLoaded;

  return (
    <main className="@container flex min-w-0 flex-1 flex-col" data-settings-view>
      <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:hidden">
        <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => uiStore.set({ sidebarOpen: true })}><MenuIcon /></Button>
        <h1 className="flex-1 text-sm font-semibold">Settings</h1>
        <Button variant="ghost" size="sm" onClick={() => closeView(activeSid)}><ArrowLeftIcon /> Back</Button>
      </header>
      {/* Positioned: an absolutely positioned descendant (Radix's hidden form input) stays in this pane and scrolls with it instead of extending the page. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 @2xl:flex-row @2xl:gap-8 @2xl:px-8 @2xl:py-10">
          <div className="@2xl:sticky @2xl:top-10 @2xl:w-48 @2xl:shrink-0 @2xl:self-start">
            <div className="mb-4 hidden items-center gap-1 md:flex">
              <Button variant="ghost" size="icon-sm" aria-label="Back" title="Back (Esc)" onClick={() => closeView(activeSid)}><ArrowLeftIcon /></Button>
              <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            </div>
            <nav
              ref={navRef}
              aria-label="Settings sections"
              className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] @2xl:mx-0 @2xl:flex-col @2xl:overflow-visible @2xl:px-0"
            >
              {sections.map((s) => (
                <a
                  key={s.id}
                  href={`#settings/${s.id}`}
                  aria-current={s.id === current.id ? 'page' : undefined}
                  onClick={(e) => { e.preventDefault(); replaceHash(`#settings/${s.id}`); }}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors',
                    s.id === current.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <s.icon className="size-4" /> {s.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="min-w-0 flex-1 pb-10" data-section={current.id}>
            {showBody && <React.Fragment key={current.id}>{current.render()}</React.Fragment>}
          </div>
        </div>
      </div>
    </main>
  );
}
