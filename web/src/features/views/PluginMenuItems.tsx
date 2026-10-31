import * as React from 'react';
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { useStore } from '@/state/createStore';
import { appLabel, catalogStore, type PluginMenuItem, type PluginRow } from './plugins';
import { menuGroups, openPluginForRow } from './pluginMenu';

/** The plugin groups of a row ⋮: one separator-led group per enabled plugin with `menuItems` in this scope. */
export function PluginMenuItems({ scope, project, worktree }: { scope: PluginMenuItem['scope']; project: string; worktree: string | null }) {
  const apps = useStore(catalogStore, (s) => s.apps);
  return menuGroups(apps, scope).map(({ app, items }) => (
    <React.Fragment key={app.id}>
      <DropdownMenuSeparator />
      <PluginMenuGroup app={app} items={items} project={project} worktree={worktree} />
    </React.Fragment>
  ));
}

function PluginMenuGroup({ app, items, project, worktree }: { app: PluginRow; items: PluginMenuItem[]; project: string; worktree: string | null }) {
  const id = React.useId();
  return (
    <DropdownMenuGroup aria-labelledby={id}>
      <DropdownMenuLabel id={id}>{appLabel(app)}</DropdownMenuLabel>
      {items.map((it, i) => (
        <DropdownMenuItem key={i} onSelect={() => openPluginForRow(app.id, it.path, { project, worktree })}>{it.label}</DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}
