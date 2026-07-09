// Workspace convention modules — the toggleable sections composed into the
// app-owned projects-root CLAUDE.md (the file every project imports via
// `@../CLAUDE.md`) alongside the always-on core.
//
// CORE (baseline/core.md) is always present. The four built-in modules
// (baseline/modules/<slug>.md) and any user-defined custom modules are
// toggled via a single GLOBAL selection (there is one projects-root
// CLAUDE.md), persisted at <orchStoreRoot>/workspace-modules.json as
// { enabled: [...], rules: [...] }.
//
// The composed file is fully app-owned: regenerated (overwritten) on boot
// and after a settings change by ensureRootClaudeMd() in rootClaudeMd.js —
// exactly like .conduct/CONDUCT.md. This mirrors src/conductModules.js.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.js';
import { createFragmentCatalog } from './fragmentCatalog.js';

const BASELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'baseline');
const CORE_FILE = path.join(BASELINE_ROOT, 'core.md');
const MODULES_DIR = path.join(BASELINE_ROOT, 'modules');

// Always-on core (baseline/core.md) — surfaced to the settings UI as a
// non-toggleable row so users see what can't be turned off.
export const CORE_META = {
  name: 'Core (always on)',
  description: 'Intro + the @../CLAUDE.md import contract every project relies on',
};

// Built-in module metadata (order = order they appear in the composed doc).
// Bodies live in baseline/modules/<slug>.md.
export const SEED_MODULES = [
  { slug: 'git-hygiene', name: 'Git hygiene',
    description: 'Init repo; git identity; commit-per-turn; .gitignore; no push; no hook bypass' },
  { slug: 'readme-maintenance', name: 'README maintenance',
    description: 'Read README before touching a project; create/update it; keep functional + technical in sync' },
  { slug: 'system-prompt-docs', name: 'System-prompt docs: instruction, not color',
    description: 'CLAUDE.md/CONDUCT.md cost tokens every session — cut color, keep behavior-changing instruction' },
  { slug: 'opening-urls', name: 'Opening URLs',
    description: 'Render actionable URLs as tappable ▶ buttons; never open them yourself; use sparingly' },
];

const catalog = createFragmentCatalog({
  seeds: SEED_MODULES,
  seedDir: MODULES_DIR,
  storeFile: () => path.join(orchStoreRoot(), 'workspace-modules.json'),
  noun: 'module',
});

// ── Fragment read (core is always-on, cached per resolved path) ──────────────

let coreCache;
async function getCore() {
  if (coreCache === undefined) coreCache = (await fs.readFile(CORE_FILE, 'utf8')).replace(/\s+$/, '');
  return coreCache;
}

// ── Catalog + CRUD (delegated to the shared helper) ──────────────────────────

export const getCatalog = catalog.getCatalog;
export const addCustomModule = catalog.addCustom;
export const updateCustomModule = catalog.updateCustom;
export const validateSlug = catalog.validateSlug;

// Deleting a custom module also drops it from the enabled selection.
export async function deleteCustomModule(slug) {
  const result = await catalog.deleteCustom(slug);
  const enabled = await getSelectionRaw();
  if (enabled?.includes(slug)) {
    await catalog.patchState({ enabled: enabled.filter(s => s !== slug) });
  }
  return result;
}

// ── Global selection ─────────────────────────────────────────────────────────

// Raw enabled array from the store (undefined when unset).
async function getSelectionRaw() {
  const state = await catalog.readState();
  return Array.isArray(state.enabled) ? state.enabled : undefined;
}

// Enabled module slugs. Default (store absent/unset) = all built-ins, so a
// fresh install renders the projects-root CLAUDE.md equivalent to the
// pre-carve bundled canonical.
export async function getSelection() {
  return (await getSelectionRaw()) ?? SEED_MODULES.map(m => m.slug);
}

export async function setSelection(enabled) {
  if (!Array.isArray(enabled)) {
    const err = new Error('enabled must be an array of slug strings');
    err.statusCode = 400;
    throw err;
  }
  const known = new Set((await getCatalog()).map(m => m.slug));
  for (const slug of enabled) {
    if (!known.has(slug)) {
      const err = new Error(`unknown module slug '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
  }
  await catalog.patchState({ enabled });
  return enabled;
}

// ── Compose ───────────────────────────────────────────────────────────────────

// core + enabled module bodies (catalog order).
export async function composeWorkspace(enabledSlugs) {
  const core = await getCore();
  const mods = (await catalog.compose(enabledSlugs)).trim();
  return [core, ...(mods ? [mods] : [])].join('\n\n') + '\n';
}

export async function composeCurrentWorkspace() {
  return composeWorkspace(await getSelection());
}
