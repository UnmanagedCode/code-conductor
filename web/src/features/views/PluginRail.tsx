// The plugin dock's icon rail: the column's right edge on desktop, beside a
// session and in the full view. One monogram per catalog app, plus the control
// that moves the shown plugin between split and the full view.
import { Maximize2Icon, PanelRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { appLabel, catalogStore } from './plugins';
import { DOCK_RAIL_WIDTH, type DockMode } from './dockLayout';
import { dockFromFull, expandDocked, pickRailApp } from './dock';
import { cn } from '@/lib/utils';

function RailButton({ label, onClick, current, collapsed, appId, children }: {
  label: string; onClick: () => void; current?: boolean; collapsed?: boolean; appId?: string; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            'size-7 text-muted-foreground hover:text-foreground aria-[current=true]:text-foreground',
            // Shown: filled; docked but collapsed: outlined.
            collapsed ? 'aria-[current=true]:ring-1 aria-[current=true]:ring-sidebar-border' : 'aria-[current=true]:bg-sidebar-accent',
          )}
          aria-label={label}
          aria-current={current || undefined}
          data-rail-app={appId}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** `markedId` is the shown app, or on the rail the docked one; `onOpen` is the column's open from the rail. */
export function PluginRail({ mode, markedId, onOpen }: { mode: DockMode; markedId: string | null; onOpen: (id: string) => void }) {
  const apps = useStore(catalogStore, (s) => s.apps);
  const route = useRoute();
  return (
    <nav aria-label="Plugin dock" className="flex shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2" style={{ width: DOCK_RAIL_WIDTH }} data-plugin-rail>
      {mode === 'split' && (
        <RailButton label="Expand to full view" onClick={expandDocked}><Maximize2Icon /></RailButton>
      )}
      {mode === 'full' && route.pluginId && (
        <RailButton label="Dock to side" onClick={() => dockFromFull(route.pluginId!, `/${route.pluginPath}`)}><PanelRightIcon /></RailButton>
      )}
      {apps.map((p) => {
        const label = appLabel(p);
        return (
          <RailButton key={p.id} label={label} appId={p.id} current={p.id === markedId} collapsed={mode === 'rail'} onClick={() => pickRailApp(p.id, mode, route, onOpen)}>
            <span className="flex size-5 items-center justify-center rounded-md border text-[11px] font-semibold uppercase">{label.slice(0, 1)}</span>
          </RailButton>
        );
      })}
    </nav>
  );
}
