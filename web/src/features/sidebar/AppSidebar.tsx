import * as React from 'react';
import {
  BarChart3Icon, FolderInputIcon, FolderPlusIcon, LayersIcon, LoaderCircleIcon, MenuIcon, MoonIcon,
  SettingsIcon, SparklesIcon, SunIcon, WifiOffIcon, XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OctopusMark } from '@/components/mascot/Octopus';
import { useStore } from '@/state/createStore';
import { appStore, activeInstance } from '@/state/app';
import { closeView, useRoute } from '@/state/route';
import { closeSidebarOnMobile, setLens, uiStore } from '@/app/ui';
import { themeStore, toggleTheme } from '@/app/theme';
import { conductStore, startConducting } from '@/features/dialogs/conduct';
import { openAdoptProjectDialog, openNewProjectDialog, openWorkspaceDialog } from '@/features/dialogs/api';
import { openCosts, openSettings } from '@/features/views/api';
import { AppSwitcher } from '@/features/views/AppSwitcher';
import { NotifyToggle } from '@/features/notifications/NotifyToggle';
import { cn } from '@/lib/utils';
import { filterOwner, SIDEBAR_DEFAULT_WIDTH } from './derive';
import { lensScrollOf, setFilter, setLensScroll, useSidebarUi } from './state';
import { useSidebarModel } from './useSidebarModel';
import { Hint, OWNER_BAR, ownerStyle } from './rows';
import { Strip } from './Strip';
import { ProjectsList } from './ProjectsList';
import { ConductorsList } from './ConductorsList';
import { RestartButton } from './RestartButton';
import { useSidebarWidth } from './useSidebarWidth';
import { scrollActiveIntoView } from './reveal';
// Side-effect import: loading reveal installs its selection subscriptions, whether or not a binding above stays used.
import './reveal';
import './filterFallback';

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Hint label={label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="text-muted-foreground hover:text-foreground">
        {children}
      </Button>
    </Hint>
  );
}

function liveSummary(n: number) {
  if (n === 0) return 'All quiet';
  return `${n} agent${n === 1 ? '' : 's'} playing`;
}

function FilterRow({ m }: { m: ReturnType<typeof useSidebarModel> }) {
  const ui = useSidebarUi();
  const owner = filterOwner(ui.filter);
  return (
    <div className={cn('mx-3 mt-2 rounded-md', owner && OWNER_BAR, owner && 'pl-[3px]')} style={ownerStyle(owner)} data-filter={ui.filter || 'all'}>
      <Select value={ui.filter || 'all'} onValueChange={(v) => setFilter(v === 'all' ? '' : v)}>
        <SelectTrigger size="sm" className="w-full bg-background/60 text-xs" aria-label="Filter by conductor">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {m.options.map((o) => (
            <SelectItem key={o.value || 'all'} value={o.value || 'all'} className="text-xs">{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AppSidebar({ mobile = false }: { mobile?: boolean }) {
  const m = useSidebarModel();
  const lens = useStore(uiStore, (s) => s.lens);
  // Each lens keeps its own scroll offset, across switches and remounts (the phone drawer re-opening).
  const bodyRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = lensScrollOf(lens);
  }, [lens]);
  // Mounting with a selection (the phone drawer re-opening) opens onto its row.
  React.useLayoutEffect(() => {
    if (bodyRef.current) scrollActiveIntoView(bodyRef.current);
  }, []);
  const starting = useStore(conductStore, (s) => s.starting);
  const active = useStore(appStore, activeInstance);
  const route = useRoute();
  const { width, handleProps } = useSidebarWidth();
  const liveCount = m.instances.filter((i) => i.status === 'turn' || i.displayStatus === 'running').length;

  const go = (fn: () => void) => () => { closeSidebarOnMobile(); fn(); };
  const toggleSettings = () => {
    if (route.view === 'settings') closeView(active?.sessionId ?? null);
    else { closeSidebarOnMobile(); openSettings(); }
  };

  return (
    <aside
      className={cn('relative flex h-full flex-col bg-sidebar text-sidebar-foreground', !mobile && 'border-r border-sidebar-border')}
      style={mobile ? undefined : { width: width ?? SIDEBAR_DEFAULT_WIDTH }}
      data-sidebar
    >
      <div className="flex items-center gap-1 px-3 pt-[max(env(safe-area-inset-top,0px),1rem)] pb-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <OctopusMark className="size-6" />
        </div>
        <AppSwitcher title="Code Conductor" subtitle={liveSummary(liveCount)} />
        <NotifyToggle />
        <HeaderButton label={route.view === 'settings' ? 'Close settings' : 'Settings'} onClick={toggleSettings}>
          <SettingsIcon />
        </HeaderButton>
        {mobile && (
          <HeaderButton label="Close" onClick={closeSidebarOnMobile}>
            <XIcon />
          </HeaderButton>
        )}
      </div>

      <div className="px-3">
        <Hint label="Start a conductor: a temp session that orchestrates other sessions for you (uses the Conductor role's model)">
          <Button className="w-full justify-start gap-2 shadow-sm" disabled={starting} onClick={() => void startConducting()} data-conduct>
            {starting ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
            Conduct
            <span className="ml-auto text-[11px] font-normal opacity-80">{starting ? 'starting…' : 'new conductor'}</span>
          </Button>
        </Hint>
      </div>

      <div ref={bodyRef} onScroll={(e) => setLensScroll(lens, e.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3" data-sidebar-body>
        <Strip m={m} />

        <div className="mt-3 flex items-center gap-1.5 px-3">
          <Tabs value={lens} onValueChange={(v) => setLens(v as 'conductors' | 'projects')} className="flex-1">
            <TabsList className="w-full">
              <TabsTrigger value="conductors">Conductors</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
            </TabsList>
          </Tabs>
          <DropdownMenu modal={false}>
            <Hint label="Project actions">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Project actions" className="text-muted-foreground"><MenuIcon /></Button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onSelect={go(openNewProjectDialog)}><FolderPlusIcon /> New project</DropdownMenuItem>
              <DropdownMenuItem onSelect={go(openAdoptProjectDialog)}><FolderInputIcon /> Add existing directory</DropdownMenuItem>
              <DropdownMenuItem onSelect={go(() => openWorkspaceDialog(null))}><LayersIcon /> New workspace</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={go(openCosts)}><BarChart3Icon /> Costs</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {lens === 'projects' && <FilterRow m={m} />}

        <div className="mt-2 px-2">
          {lens === 'conductors' ? <ConductorsList m={m} /> : <ProjectsList m={m} />}
        </div>
      </div>

      <Footer />

      {!mobile && (
        <div
          {...handleProps}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/20 data-[active=true]:bg-primary/30"
          data-resize-handle
        />
      )}
    </aside>
  );
}

function ThemeButton() {
  const theme = useStore(themeStore, (s) => s.resolved);
  return (
    <HeaderButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={toggleTheme}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </HeaderButton>
  );
}

function Footer() {
  const status = useStore(appStore, (s) => s.sidebarStatus);
  const connection = useStore(appStore, (s) => s.connection);
  const everDropped = useStore(appStore, (s) => s.everDropped);
  const reconnecting = connection === 'reconnecting' && everDropped;
  const text = status?.text ?? (reconnecting ? 'Reconnecting…' : null);
  return (
    <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-2 pb-[max(env(safe-area-inset-bottom,0px),0.5rem)]" data-sidebar-footer>
      <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-xs', text ? 'text-warning' : 'text-muted-foreground')} aria-live="polite" data-sidebar-status>
        {text ? (
          <>
            {reconnecting && !status ? <WifiOffIcon className="size-3.5 shrink-0" /> : <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />}
            <span className="truncate">{text}</span>
          </>
        ) : connection === 'open' ? (
          <><span className="size-1.5 rounded-full bg-success" /> Connected</>
        ) : (
          <><LoaderCircleIcon className="size-3.5 animate-spin" /> Connecting…</>
        )}
      </div>
      <ThemeButton />
      <RestartButton />
    </div>
  );
}

