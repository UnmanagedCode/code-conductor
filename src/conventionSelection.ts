// Shared convention SELECTION layer — which of a fragment catalog's entries are
// currently enabled, and how a submitted checkbox set is persisted.
//
// Selection is a second concern from the catalog's own CRUD/compose, so it is a
// composed collaborator built ON TOP of a FragmentCatalog rather than another
// method on it. Two scopes use it (workspace + conductor); the project scope has
// no selection concept at all — its picks live in the in-tree CONVENTIONS.md
// line-1 marker, owned by src/projectClaudeMd.ts.
//
// The shared body owns the base read, the setSelection validation (array guard +
// unknown-slug 400) and the delete-drops-it-from-`enabled` rule. Everything a
// scope does differently rides one of two hooks:
//
//   derive  — store state → effective selection (conductor folds in the enabled
//             plugins' conventions minus its pluginOff list)
//   persist — submitted set → the store patch (conductor splits it into
//             `enabled` + `pluginOff`)
//
// `derive` receives the catalog as a LAZY THUNK, not a resolved list. Workspace's
// derivation is store-read-only, and every composeCurrentWorkspace() /
// GET /settings/conventions/workspace would otherwise re-read all seed fragments
// off disk for nothing. The default derive never invokes the thunk.

import type { CatalogList, FragmentCatalog } from './fragmentCatalog.ts';
import { httpError } from './httpError.ts';

interface SelectionStoreConfig {
  // catalog: the FragmentCatalog this selection sits on (state + entry list)
  // seeds:   built-in metadata; their slugs are the default selection when the
  //          store carries no `enabled` key (so a future-added built-in defaults on)
  // noun:    label used in the unknown-slug 400 — pass the same one the catalog got
  catalog: FragmentCatalog;
  seeds: Array<{ slug: string }>;
  noun?: string;
  derive?: (ctx: { base: string[]; state: Record<string, unknown>; catalog: () => Promise<CatalogList> }) => Promise<string[]>;
  persist?: (ctx: { submitted: string[]; state: Record<string, unknown>; catalog: CatalogList }) => Record<string, unknown>;
}

export interface SelectionStore {
  getSelection(): Promise<string[]>;
  setSelection(enabled: string[]): Promise<string[]>;
  deleteCustom(slug: string): Promise<{ slug: string }>;
}

export function createSelectionStore({
  catalog,
  seeds,
  noun = 'convention',
  derive = async ({ base }) => base,
  persist = ({ submitted }) => ({ enabled: submitted }),
}: SelectionStoreConfig): SelectionStore {
  // Base = the persisted selection, or all seed slugs when the key is absent.
  // Absence is the DEFAULT state, not an empty selection: a fresh install
  // composes every built-in.
  async function getSelection(): Promise<string[]> {
    const state = await catalog.readState();
    const base = Array.isArray(state.enabled) ? state.enabled as string[] : seeds.map(s => s.slug);
    return derive({ base, state, catalog: () => catalog.getCatalog() });
  }

  async function setSelection(enabled: string[]): Promise<string[]> {
    if (!Array.isArray(enabled)) {
      throw httpError(400, 'enabled must be an array of slug strings');
    }
    const cat = await catalog.getCatalog();
    const known = new Set(cat.map(m => m.slug));
    for (const slug of enabled) {
      if (!known.has(slug)) {
        throw httpError(400, `unknown ${noun} slug '${slug}'`);
      }
    }
    const state = await catalog.readState();
    await catalog.patchState(persist({ submitted: enabled, state, catalog: cat }));
    return enabled;
  }

  // Deleting a custom entry also drops it from the persisted selection — the
  // base `enabled` array is the only place a custom slug can appear (plugin
  // slugs are never custom), so no derive/persist hook is involved.
  async function deleteCustom(slug: string): Promise<{ slug: string }> {
    const result = await catalog.deleteCustom(slug);
    const enabled = (await catalog.readState()).enabled;
    if (Array.isArray(enabled) && (enabled as string[]).includes(slug)) {
      await catalog.patchState({ enabled: (enabled as string[]).filter(s => s !== slug) });
    }
    return result;
  }

  return { getSelection, setSelection, deleteCustom };
}
