// What a plugin's row ⋮ buttons (`menuItems`) do: which groups a scope shows, and
// the click that opens the plugin's frontend with the row's project (and worktree)
// in the frame URL's query (docs/plugins.md → menuItems).
import { openPlugin } from './api';
import { showLinkInDock } from './dock';
import { appLabel, type PluginMenuItem, type PluginRow } from './plugins';

/** The query parameters a plugin page reads its row from. */
export const SCOPE_PARAMS = { project: 'ccProject', worktree: 'ccWorktree' } as const;

export type RowScope = { project: string; worktree: string | null };

/** `path` plus the row's scope as a query; names are form-urlencoded, so none can leave the query or the plugin's path. */
export function pluginScopeSubpath(path: string, scope: RowScope): string {
  const q = new URLSearchParams({ [SCOPE_PARAMS.project]: scope.project });
  if (scope.worktree !== null) q.set(SCOPE_PARAMS.worktree, scope.worktree);
  return `${path}?${q}`;
}

/** Catalog order, items filtered to `scope`; a plugin with none in scope has no group. */
export function menuGroups(apps: PluginRow[], scope: PluginMenuItem['scope']): Array<{ app: PluginRow; items: PluginMenuItem[] }> {
  return apps
    .map((app) => ({ app, items: (app.menuItems ?? []).filter((i) => i.scope === scope) }))
    .filter((g) => g.items.length > 0);
}

/** The row ⋮'s plugin sections: plugins with one item in scope as flat entries, plugins with more as headed groups; each in catalog order. */
export function menuSections(apps: PluginRow[], scope: PluginMenuItem['scope']) {
  const groups = menuGroups(apps, scope);
  return {
    singles: groups.filter((g) => g.items.length === 1).map(({ app, items: [item] }) => ({ app, item: item! })),
    groups: groups.filter((g) => g.items.length > 1),
  };
}

const CODE_PREFIX = /^Code\s+(\S.*)$/;
/** The trailing tag of a flat plugin entry: `appLabel` without a leading "Code ", else the whole label. */
export const pluginShortName = (app: Pick<PluginRow, 'name' | 'navLabel'>) => CODE_PREFIX.exec(appLabel(app))?.[1] ?? appLabel(app);

/** The dock when a plugin shows beside the session (replacing a different docked plugin), else the plugin's full view. */
export function openPluginForRow(id: string, path: string, scope: RowScope) {
  const subpath = pluginScopeSubpath(path, scope);
  if (!showLinkInDock(`#plugin/${id}${subpath}`)) openPlugin(id, subpath.slice(1));
}
