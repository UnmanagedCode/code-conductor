// Conductor conventions — the toggleable sections composed into the
// live .conduct/CONDUCT.md alongside the always-on core.
//
// CORE (conventions/conductor/core.md) + a footer note
// (conventions/conductor/footer.md) are always present. The built-in
// conventions (conventions/conductor/<slug>.md) and any user-defined custom
// conventions are toggled via a single GLOBAL selection (the conductor is a
// singleton), persisted at
// <orchStoreRoot>/conventions/conductor.json as { enabled: [...], rules: [...] }.
//
// Every enabled convention costs tokens in every conductor session's system
// prompt — keep the built-in set lean; project-specific detail belongs in
// .conduct/tasks/*.md playbooks and the wiki, not here.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.js';
import { createFragmentCatalog } from './fragmentCatalog.js';

const CONVENTIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conventions', 'conductor');
const CORE_FILE = path.join(CONVENTIONS_DIR, 'core.md');
const FOOTER_FILE = path.join(CONVENTIONS_DIR, 'footer.md');

// Always-on core (conventions/conductor/core.md) — surfaced to the settings UI
// as a non-toggleable row so users see what can't be turned off.
export const CORE_META = {
  name: 'Core (always on)',
  description: 'Role, hard boundary, dispatch-and-wake, MCP toolbelt, project-conventions on creation, safety, talking to the user',
};

// Built-in convention metadata (order = order they appear in the composed doc).
// Bodies live in conventions/conductor/<slug>.md.
export const SEED_CONVENTIONS = [
  { slug: 'intent-disambiguation', name: 'Intent disambiguation',
    description: "Ground ambiguous asks in list_projects(); use MCP not shell to enumerate; ask before creating" },
  { slug: 'canonical-workflow', name: 'Canonical workflow',
    description: 'The recon→spawn→brief→wake→review→land loop, single and N-parallel' },
  { slug: 'worker-lifecycle', name: 'Worker lifecycle',
    description: 'Reuse same-file workers across merges; retire when the thread ends' },
  { slug: 'operational-tasks', name: 'Operational tasks in other projects',
    description: 'Route even read-only work through a spawned session' },
  { slug: 'worker-prompts', name: 'Worker prompt best practices',
    description: 'Scope, declare env, sentinel, one concern, model ladder' },
  { slug: 'capturing-learnings', name: 'Capturing learnings',
    description: 'Where durable lessons go (private knowledge store vs CLAUDE.md), always opt-in' },
  { slug: 'context-renewal', name: 'Context renewal',
    description: 'Shed dead-weight history about landed jobs via renew_session at lifecycle seams' },
  { slug: 'system-prompt-gate', name: 'System-prompt text gate',
    description: 'Audit system-prompt text diffs against the writing principles before approve/merge' },
];

// Plugin-contributed conductor-convention fragments join the catalog through
// this provider, mirroring projectConventions.js's identical pattern. Injected
// after construction (server.js wires it to the plugin host); default no-op
// so plugin-less imports/tests work.
let pluginConductorConventionsProvider = async () => [];
export function setPluginConductorConventionsProvider(fn) {
  pluginConductorConventionsProvider = fn ?? (async () => []);
}

const catalog = createFragmentCatalog({
  seeds: SEED_CONVENTIONS,
  seedDir: CONVENTIONS_DIR,
  storeFile: () => path.join(orchStoreRoot(), 'conventions', 'conductor.json'),
  noun: 'convention',
  extraProvider: () => pluginConductorConventionsProvider(),
});

// ── Fragment reads (core + footer are always-on, cached per resolved path) ──

let coreCache; let footerCache;
async function getCore() {
  if (coreCache === undefined) coreCache = (await fs.readFile(CORE_FILE, 'utf8')).replace(/\s+$/, '');
  return coreCache;
}
async function getFooter() {
  if (footerCache === undefined) footerCache = (await fs.readFile(FOOTER_FILE, 'utf8')).replace(/\s+$/, '');
  return footerCache;
}

// ── Catalog + CRUD (delegated to the shared helper) ──────────────────────────

export const getCatalog = catalog.getCatalog;
export const addCustomConvention = catalog.addCustom;
export const updateCustomConvention = catalog.updateCustom;
export const validateSlug = catalog.validateSlug;

// Deleting a custom convention also drops it from the enabled selection.
export async function deleteCustomConvention(slug) {
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

// Enabled convention slugs. Default (store absent/unset) = all built-ins, so a
// fresh install renders guidance equivalent to the pre-carve CONDUCT.md.
export async function getSelection() {
  return (await getSelectionRaw()) ?? SEED_CONVENTIONS.map(m => m.slug);
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
      const err = new Error(`unknown convention slug '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
  }
  await catalog.patchState({ enabled });
  return enabled;
}

// ── Compose ───────────────────────────────────────────────────────────────────

// core + enabled convention bodies (catalog order) + footer.
export async function composeConduct(enabledSlugs) {
  const core = await getCore();
  const footer = await getFooter();
  const mods = (await catalog.compose(enabledSlugs)).trim();
  return [core, ...(mods ? [mods] : []), footer].join('\n\n') + '\n';
}

export async function composeCurrentConduct() {
  return composeConduct(await getSelection());
}
