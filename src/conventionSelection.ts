// Shared convention SELECTION layer — which of a fragment catalog's entries are
// currently enabled, and how a submitted checkbox set is persisted.
//
// Selection is a second concern from the catalog's own CRUD/compose, so it is a
// composed collaborator built ON TOP of a FragmentCatalog rather than another
// method on it. Two scopes use it (workspace + conductor); the project scope has
// no selection concept at all — its picks live in the in-tree CONVENTIONS.md
// line-1 marker, owned by src/projectClaudeMd.ts.
//
// THE PERSISTED STATE IS A DENY-LIST (`disabled`), never an allow-list — card
// 2026-0123. Everything the scope knows about is enabled unless the user
// switched it off, so a slug added to SEED_CONVENTIONS reaches every install,
// fresh or existing, with no migration. The allow-list this replaced needed one
// per added seed (migrations 0015, 0029): any store that had ever persisted a
// selection froze the set it was written with, and every later seed sat
// unchecked forever.
//
// The shared body owns the base read (everything the scope knows, minus
// `disabled`), the setSelection validation (array guard + unknown-slug 400), the
// submitted-set → `disabled` diff, and the delete-prunes-it-from-`disabled`
// rule. A scope that derives more than it persists rides one hook:
//
//   derive  — store state → effective selection (conductor folds in the enabled
//             plugins' conventions, minus `disabled`)
//
// `derive` receives the catalog as a LAZY THUNK, not a resolved list. Workspace's
// derivation is store-read-only, and every composeCurrentWorkspace() /
// GET /settings/conventions/workspace would otherwise re-read all seed fragments
// off disk for nothing. The default derive never invokes the thunk.

import type { CatalogList, FragmentCatalog } from './fragmentCatalog.ts';
import { httpError } from './httpError.ts';

interface SelectionStoreConfig {
  // catalog: the FragmentCatalog this selection sits on (state + entry list)
  // seeds:   built-in metadata; every slug is enabled unless the store's
  //          `disabled` deny-list names it (so a future-added built-in is on)
  // noun:    label used in the unknown-slug 400 — pass the same one the catalog got
  catalog: FragmentCatalog;
  seeds: Array<{ slug: string }>;
  noun?: string;
  derive?: (ctx: { base: string[]; state: Record<string, unknown>; catalog: () => Promise<CatalogList> }) => Promise<string[]>;
}

export interface SelectionStore {
  getSelection(): Promise<string[]>;
  setSelection(enabled: string[]): Promise<string[]>;
  deleteCustom(slug: string): Promise<{ slug: string }>;
}

// The persisted off-switches. Exported because the conductor scope's `derive`
// subtracts the very same set from its live plugin entries — one reader of the
// key, not two shapes of it.
export function disabledOf(state: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(state.disabled) ? state.disabled as string[] : []);
}

export function createSelectionStore({
  catalog,
  seeds,
  noun = 'convention',
  derive = async ({ base }) => base,
}: SelectionStoreConfig): SelectionStore {
  // Base = everything this scope knows about (seed + custom slugs), minus the
  // persisted off-switches. Order is seed order then custom order — the base is
  // built from the catalog's own ordering, so it never echoes the order a
  // settings save happened to submit.
  async function getSelection(): Promise<string[]> {
    const state = await catalog.readState();
    const off = disabledOf(state);
    const base = [...seeds.map(s => s.slug), ...catalog.customSlugsOf(state)]
      .filter(s => !off.has(s));
    return derive({ base, state, catalog: () => catalog.getCatalog() });
  }

  // The submitted checkbox set, folded into the persisted deny-list: for every
  // slug the LIVE CATALOG can see, checked clears its off-switch and unchecked
  // records one. A slug the catalog cannot currently see — an unreachable or
  // disabled plugin's convention — keeps whatever off-state it already had, so
  // an off-switch survives a disable→re-enable round trip.
  function nextDisabled({ submitted, state, catalog: cat }:
  { submitted: string[]; state: Record<string, unknown>; catalog: CatalogList }): Record<string, unknown> {
    const submittedSet = new Set(submitted);
    const off = disabledOf(state);
    for (const m of cat) {
      if (submittedSet.has(m.slug)) off.delete(m.slug);
      else off.add(m.slug);
    }
    return { disabled: [...off] };
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
    await catalog.patchState(nextDisabled({ submitted: enabled, state, catalog: cat }));
    return enabled;
  }

  // Deleting a custom entry also prunes it from the deny-list. Without that, a
  // custom the user had switched off leaves an off-switch behind, and a
  // re-created entry of the same slug would silently come back OFF while every
  // other new entry is on.
  async function deleteCustom(slug: string): Promise<{ slug: string }> {
    const result = await catalog.deleteCustom(slug);
    const off = disabledOf(await catalog.readState());
    if (off.delete(slug)) {
      await catalog.patchState({ disabled: [...off] });
    }
    return result;
  }

  return { getSelection, setSelection, deleteCustom };
}
