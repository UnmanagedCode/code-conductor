import * as React from 'react';
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut } from '@/components/ui/dropdown-menu';
import { useStore } from '@/state/createStore';
import { appLabel, catalogStore, type PluginMenuItem, type PluginRow } from './plugins';
import { menuSections, openPluginForRow, pluginShortName, type RowScope } from './pluginMenu';
import { PluginIcon } from './PluginIcon';

/** The plugin entries of a row ⋮: plugins with one item in this scope are flat entries (icon, trailing plugin tag) behind one separator; plugins with more keep a separator-led, labelled group each, after them. */
export function PluginMenuItems({ scope, project, worktree }: { scope: PluginMenuItem['scope']; project: string; worktree: string | null }) {
  const apps = useStore(catalogStore, (s) => s.apps);
  const { singles, groups } = menuSections(apps, scope);
  const row = { project, worktree };
  return (
    <>
      {singles.length > 0 && <DropdownMenuSeparator />}
      {singles.map(({ app, item }) => <PluginEntry key={app.id} app={app} item={item} row={row} tag={pluginShortName(app)} />)}
      {groups.map(({ app, items }) => (
        <React.Fragment key={app.id}>
          <DropdownMenuSeparator />
          <PluginMenuGroup app={app} items={items} row={row} />
        </React.Fragment>
      ))}
    </>
  );
}

function PluginMenuGroup({ app, items, row }: { app: PluginRow; items: PluginMenuItem[]; row: RowScope }) {
  const id = React.useId();
  return (
    <DropdownMenuGroup aria-labelledby={id}>
      <DropdownMenuLabel id={id}>{appLabel(app)}</DropdownMenuLabel>
      {items.map((it, i) => <PluginEntry key={i} app={app} item={it} row={row} />)}
    </DropdownMenuGroup>
  );
}

/** One item; `tag` is the plugin's name, shown trailing but described-by only, so the item's accessible name stays its label. */
function PluginEntry({ app, item, row, tag }: { app: PluginRow; item: PluginMenuItem; row: RowScope; tag?: string }) {
  const tagId = React.useId();
  return (
    <DropdownMenuItem textValue={item.label} aria-describedby={tag ? tagId : undefined} onSelect={() => openPluginForRow(app.id, item.path, row)}>
      <PluginIcon icon={app.icon} />
      <span className="min-w-0 truncate">{item.label}</span>
      {tag && <DropdownMenuShortcut id={tagId} aria-hidden className="max-w-24 shrink-0 truncate pl-3 tracking-normal">{tag}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}
