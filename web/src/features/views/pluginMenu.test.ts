// The pure half of a plugin's row ⋮ buttons: the scope query, and which groups a scope shows.
import { describe, expect, it } from 'vitest';
import { parseHash, viewLinkHash } from '@/state/route';
import { menuGroups, pluginScopeSubpath } from './pluginMenu';
import type { PluginRow } from './plugins';

describe('pluginScopeSubpath', () => {
  // Pins: the documented parameter name `ccProject`, and that a project-scope subpath carries no worktree parameter.
  it('a project-scope subpath carries only ccProject', () => {
    expect(pluginScopeSubpath('/board', { project: 'api', worktree: null })).toBe('/board?ccProject=api');
  });

  // Pins: a worktree-scope subpath carries both documented parameters, each under its own name.
  it('a worktree-scope subpath carries the project and the worktree, unswapped', () => {
    const q = new URLSearchParams(pluginScopeSubpath('/diff', { project: 'api', worktree: 'wt1' }).split('?')[1]);
    expect(q.get('ccProject')).toBe('api');
    expect(q.get('ccWorktree')).toBe('wt1');
  });

  // Pins: names are encoded, so a hostile one cannot cut the URL at `#`, `?` or `&`, inject a parameter, or leave the plugin's path.
  it('hostile names cannot leave the query or the plugin\'s path', () => {
    const P = 'a/b?c#d&ccWorktree=x%2F+ ..';
    const W = '..';
    const sub = pluginScopeSubpath('/diff', { project: P, worktree: W });
    const u = new URL(`/plugins/alpha${sub}`, location.origin);
    expect(u.pathname).toBe('/plugins/alpha/diff');
    expect(u.hash).toBe('');
    expect([...u.searchParams.keys()]).toEqual(['ccProject', 'ccWorktree']);
    expect(u.searchParams.get('ccProject')).toBe(P);
    expect(u.searchParams.get('ccWorktree')).toBe(W);
    expect(viewLinkHash(`#plugin/alpha${sub}`)).not.toBeNull();
    expect(`/${parseHash(`#plugin/alpha${sub}`).pluginPath}`).toBe(sub);
  });
});

describe('menuGroups', () => {
  const app = (id: string, menuItems?: PluginRow['menuItems']): PluginRow => ({ id, name: id, enabled: true, hasFrontend: true, menuItems });
  const apps = [
    app('a', [{ label: 'A1', scope: 'project', path: '/1' }, { label: 'A2', scope: 'worktree', path: '/2' }, { label: 'A3', scope: 'project', path: '/3' }]),
    app('b', [{ label: 'B1', scope: 'worktree', path: '/1' }]),
    app('c', [{ label: 'C1', scope: 'project', path: '/1' }]),
    app('d'),
  ];
  const shape = (scope: 'project' | 'worktree') => menuGroups(apps, scope).map((g) => [g.app.id, g.items.map((i) => i.label)]);

  // Pins: catalog order, manifest order within a group, the scope filter, and no group for a plugin with nothing in scope.
  it('keeps catalog order and manifest order, filters by scope, drops plugins with nothing in scope', () => {
    expect(shape('project')).toEqual([['a', ['A1', 'A3']], ['c', ['C1']]]);
    expect(shape('worktree')).toEqual([['a', ['A2']], ['b', ['B1']]]);
  });
});
