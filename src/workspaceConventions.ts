// Workspace conventions — the "applies to every project" sections, composed
// alongside the always-on core into one text with no destination of its own.
//
// CORE (conventions/workspace/core.md) is always present. The four built-in
// conventions (conventions/workspace/<slug>.md) and any user-defined custom
// conventions are toggled via a single GLOBAL selection — installation-wide by
// design, so it can never drift per project — persisted at
// <orchStoreRoot>/conventions/workspace.json as { enabled: [...], rules: [...] }.
//
// Delivery is per destination, and every destination is app-owned + fully
// overwritten: src/projectClaudeMd.ts folds this text into each project's
// in-tree CONVENTIONS.md (on boot and after every workspace-settings change),
// and src/conduct.ts prepends it to the conductor role doc it materializes into
// `.conduct/CONVENTIONS.md` before every conductor spawn.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.ts';
import { createFragmentCatalog } from './fragmentCatalog.ts';
import { createSelectionStore } from './conventionSelection.ts';

const CONVENTIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conventions', 'workspace');
const CORE_FILE = path.join(CONVENTIONS_DIR, 'core.md');

// Always-on core (conventions/workspace/core.md) — surfaced to the settings UI
// as a non-toggleable row so users see what can't be turned off.
export const CORE_META = {
  name: 'Core (always on)',
  description: 'Intro + the per-project CONVENTIONS.md delivery contract',
};

// Built-in convention metadata (order = order they appear in the composed doc).
// Bodies live in conventions/workspace/<slug>.md.
export const SEED_CONVENTIONS: Array<{ slug: string; name: string; description: string }> = [
  { slug: 'git-hygiene', name: 'Git hygiene',
    description: 'Init repo; git identity; commit-per-turn; .gitignore; no push; no hook bypass' },
  { slug: 'readme-maintenance', name: 'README maintenance',
    description: 'Read README before touching a project; create/update it; keep functional + technical in sync' },
  { slug: 'system-prompt-docs', name: 'System-prompt docs',
    description: 'CLAUDE.md + the conductor role doc cost tokens every session — cut color, keep behavior-changing instruction' },
  { slug: 'opening-urls', name: 'Opening URLs',
    description: 'Render actionable URLs as tappable ▶ buttons; never open them yourself; use sparingly' },
];

const catalog = createFragmentCatalog({
  seeds: SEED_CONVENTIONS,
  seedDir: CONVENTIONS_DIR,
  storeFile: () => path.join(orchStoreRoot(), 'conventions', 'workspace.json'),
  noun: 'convention',
});

// ── Fragment read (core is always-on, cached per resolved path) ──────────────

let coreCache: string | undefined;
async function getCore(): Promise<string> {
  if (coreCache === undefined) coreCache = (await fs.readFile(CORE_FILE, 'utf8')).replace(/\s+$/, '');
  return coreCache;
}

// ── Catalog + CRUD (delegated to the shared helper) ──────────────────────────

export const getCatalog = catalog.getCatalog;
export const addCustomConvention = catalog.addCustom;
export const updateCustomConvention = catalog.updateCustom;
export const validateSlug = catalog.validateSlug;

// ── Global selection (the shared collaborator, no overrides) ────────────────
//
// Plain selection: the persisted `enabled` array is the whole story, and its
// absence defaults to all built-ins so a fresh install composes the equivalent
// of the pre-carve bundled canonical. Deleting a custom convention also drops
// it from that array.

const selection = createSelectionStore({ catalog, seeds: SEED_CONVENTIONS, noun: 'convention' });

export const getSelection = selection.getSelection;
export const setSelection = selection.setSelection;
export const deleteCustomConvention = selection.deleteCustom;

// ── Compose ───────────────────────────────────────────────────────────────────

// core + enabled convention bodies (catalog order).
export async function composeWorkspace(enabledSlugs: string[]): Promise<string> {
  const core = await getCore();
  const mods = (await catalog.compose(enabledSlugs)).trim();
  return [core, ...(mods ? [mods] : [])].join('\n\n') + '\n';
}

export async function composeCurrentWorkspace(): Promise<string> {
  return composeWorkspace(await getSelection());
}

