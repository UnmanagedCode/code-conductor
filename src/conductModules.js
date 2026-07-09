// Conductor convention modules — the toggleable sections composed into the
// live .conduct/CONDUCT.md alongside the always-on core.
//
// CORE (conduct/core.md) + a footer note (conduct/footer.md) are always
// present. The eight built-in modules (conduct/modules/<slug>.md) and any
// user-defined custom modules are toggled via a single GLOBAL selection
// (the conductor is a singleton), persisted at
// <orchStoreRoot>/conduct-modules.json as { enabled: [...], rules: [...] }.
//
// Every enabled module costs tokens in every conductor session's system
// prompt — keep the built-in set lean; project-specific detail belongs in
// .conduct/tasks/*.md playbooks and the wiki, not here.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.js';
import { createFragmentCatalog } from './fragmentCatalog.js';

const CONDUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conduct');
const CORE_FILE = path.join(CONDUCT_ROOT, 'core.md');
const FOOTER_FILE = path.join(CONDUCT_ROOT, 'footer.md');
const MODULES_DIR = path.join(CONDUCT_ROOT, 'modules');

// Always-on core (conduct/core.md) — surfaced to the settings UI as a
// non-toggleable row so users see what can't be turned off.
export const CORE_META = {
  name: 'Core (always on)',
  description: 'Role, hard boundary, dispatch-and-wake, MCP toolbelt, project-conventions on creation, safety',
};

// Built-in module metadata (order = order they appear in the composed doc).
// Bodies live in conduct/modules/<slug>.md.
export const SEED_MODULES = [
  { slug: 'intent-disambiguation', name: 'Intent disambiguation',
    description: "Ground ambiguous asks in list_projects(); use MCP not shell to enumerate; ask before creating" },
  { slug: 'canonical-workflow', name: 'Canonical workflow (single & parallel)',
    description: 'The recon→spawn→brief→wake→review→land loop, single and N-parallel' },
  { slug: 'worker-lifecycle', name: 'Worker lifecycle',
    description: 'Reuse unmerged same-file workers; merge is terminal; retire after' },
  { slug: 'operational-tasks', name: 'Operational tasks in other projects',
    description: 'Route even read-only work through a spawned session' },
  { slug: 'worker-prompts', name: 'Worker-prompt best practices',
    description: 'Scope, declare env, sentinel, one concern, model ladder' },
  { slug: 'execution-modes', name: 'Execution modes',
    description: 'Plan+manual / plan+auto-approve / code-from-start' },
  { slug: 'talking-to-user', name: 'Talking to the user',
    description: 'Be concise; reference workers by short sessionId' },
  { slug: 'capturing-learnings', name: 'Capturing learnings',
    description: 'Where durable lessons go (auto-memory vs CLAUDE.md), always opt-in' },
];

const catalog = createFragmentCatalog({
  seeds: SEED_MODULES,
  seedDir: MODULES_DIR,
  storeFile: () => path.join(orchStoreRoot(), 'conduct-modules.json'),
  noun: 'module',
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
// fresh install renders guidance equivalent to the pre-carve CONDUCT.md.
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

// core + enabled module bodies (catalog order) + footer.
export async function composeConduct(enabledSlugs) {
  const core = await getCore();
  const footer = await getFooter();
  const mods = (await catalog.compose(enabledSlugs)).trim();
  return [core, ...(mods ? [mods] : []), footer].join('\n\n') + '\n';
}

export async function composeCurrentConduct() {
  return composeConduct(await getSelection());
}
