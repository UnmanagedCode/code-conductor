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
import { AccountSection } from './AccountSection';
import { VoiceSection } from './VoiceSection';
import { ConventionsSection, clearConventionsListErrors } from './ConventionsSection';
import { PluginsSection, resetPluginNotes } from './PluginsSection';
import { ArchivedSection } from './ArchivedSection';
import { AboutSection } from './AboutSection';

export type SectionId = 'models' | 'conventions' | 'plugins' | 'backends' | 'systems' | 'account' | 'voice' | 'archived' | 'about';

export const SECTIONS: { id: SectionId; label: string; icon: React.ComponentType<{ className?: string }>; capability?: 'remoteSystems' | 'voice'; render: () => React.ReactNode }[] = [
  { id: 'models', label: 'Models', icon: CpuIcon, render: () => <ModelsSection /> },
  { id: 'conventions', label: 'Conventions', icon: ScrollTextIcon, render: () => <ConventionsSection /> },
  { id: 'plugins', label: 'Plugins', icon: PlugIcon, render: () => <PluginsSection /> },
  { id: 'backends', label: 'Backends', icon: LayersIcon, render: () => <BackendsSection /> },
  { id: 'systems', label: 'Systems', icon: ServerIcon, capability: 'remoteSystems', render: () => <SystemsSection /> },
  { id: 'account', label: 'Account', icon: KeyRoundIcon, render: () => <AccountSection /> },
  { id: 'voice', label: 'Voice', icon: MicIcon, capability: 'voice', render: () => <VoiceSection /> },
  { id: 'archived', label: 'Archived', icon: ArchiveIcon, render: () => <ArchivedSection /> },
  { id: 'about', label: 'About', icon: InfoIcon, render: () => <AboutSection /> },
];

/**
 * The sections this platform offers. Until capabilities load (`caps` null)
 * every section shows; a platform without remote systems / voice drops those,
 * so they are never fetched.
 */
export function visibleSections(caps: { remoteSystems?: boolean; voice?: boolean } | null) {
  return SECTIONS.filter((s) => !s.capability || !caps || !!caps[s.capability]);
}

export function SettingsView() {
  const route = useRoute();
  const activeSid = useStore(appStore, (s) => activeInstance(s)?.sessionId ?? null);
  const [caps, setCaps] = React.useState<{ remoteSystems?: boolean; voice?: boolean } | null>(null);
  const [capsLoaded, setCapsLoaded] = React.useState(false);
  const sections = visibleSections(caps);
  const requested = (route.section as SectionId | null) ?? 'models';
  const current = sections.find((s) => s.id === requested) ?? sections[0];
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:hidden">
        <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => uiStore.set({ sidebarOpen: true })}><MenuIcon /></Button>
        <h1 className="flex-1 text-sm font-semibold">Settings</h1>
        <Button variant="ghost" size="sm" onClick={() => closeView(activeSid)}><ArrowLeftIcon /> Back</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
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
