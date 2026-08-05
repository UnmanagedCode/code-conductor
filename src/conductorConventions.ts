// Conductor conventions — the toggleable sections composed alongside the
// always-on core into the conductor's role prompt, injected at spawn via
// `--append-system-prompt` (see Instance.launch/spawn in src/instances.ts).
//
// CORE (conventions/conductor/core.md) + a footer note
// (conventions/conductor/footer.md) are always present. The built-in
// conventions (conventions/conductor/<slug>.md) and any user-defined custom
// conventions are toggled via a single GLOBAL selection (the conductor is a
// singleton), persisted at
// <orchStoreRoot>/conventions/conductor.json (keys: `rules`, `enabled`, `pluginOff`).
//
// Every enabled convention costs tokens in every conductor session's system
// prompt — keep the built-in set lean; project-specific detail belongs in
// .conduct/tasks/*.md playbooks and the wiki, not here.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.ts';
import { createFragmentCatalog, type ExtraEntry } from './fragmentCatalog.ts';

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
export const SEED_CONVENTIONS: Array<{ slug: string; name: string; description: string }> = [
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
// this provider, mirroring projectConventions.ts's identical pattern. Injected
// after construction (server.ts wires it to the plugin host); default no-op
// so plugin-less imports/tests work.
let pluginConductorConventionsProvider: () => Promise<ExtraEntry[]> = async () => [];
export function setPluginConductorConventionsProvider(fn: (() => Promise<ExtraEntry[]>) | null | undefined): void {
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

let coreCache: string | undefined; let footerCache: string | undefined;
async function getCore(): Promise<string> {
  if (coreCache === undefined) coreCache = (await fs.readFile(CORE_FILE, 'utf8')).replace(/\s+$/, '');
  return coreCache;
}
async function getFooter(): Promise<string> {
  if (footerCache === undefined) footerCache = (await fs.readFile(FOOTER_FILE, 'utf8')).replace(/\s+$/, '');
  return footerCache;
}

// ── Catalog + CRUD (delegated to the shared helper) ──────────────────────────

export const getCatalog = catalog.getCatalog;
export const addCustomConvention = catalog.addCustom;
export const updateCustomConvention = catalog.updateCustom;
export const validateSlug = catalog.validateSlug;

// Deleting a custom convention also drops it from the enabled selection.
export async function deleteCustomConvention(slug: string) {
  const result = await catalog.deleteCustom(slug);
  const enabled = (await catalog.readState()).enabled;
  if (Array.isArray(enabled) && (enabled as string[]).includes(slug)) {
    await catalog.patchState({ enabled: (enabled as string[]).filter(s => s !== slug) });
  }
  return result;
}

// ── Global selection ─────────────────────────────────────────────────────────
//
// A plugin's conductor conventions are ON by default the moment the plugin is
// enabled, so the only per-convention state worth persisting is the user's
// explicit OFF-switches. The selection keys in the store (see the read in
// `getEffectiveSelection`):
//   enabled   — seed/custom selection ONLY (absent ⇒ default all seeds, so a
//               future-added built-in defaults on); plugin slugs never live here.
//   pluginOff — namespaced <id>/<slug> conventions the user explicitly unchecked.
//
// Effective selection = base ∪ (conventions of currently-enabled plugins −
// pluginOff). getCatalog() surfaces plugin conventions from ENABLED plugins
// only, so a disabled plugin's conventions vanish automatically — no purge
// needed, and a stale slug can never reach compose() (no 400). Plugin UPDATES
// that add a convention get it on automatically; a removed one drops out.

const isPluginSlug = (s: string): boolean => typeof s === 'string' && s.includes('/'); // namespaced <id>/<slug>; seeds/custom never contain '/'

async function readSel(): Promise<{ base: string[]; off: string[] }> {
  const state = await catalog.readState();
  return {
    base: (Array.isArray(state.enabled)
      ? state.enabled as string[]
      : SEED_CONVENTIONS.map(m => m.slug)).filter(s => !isPluginSlug(s)),
    off: Array.isArray(state.pluginOff) ? state.pluginOff as string[] : [],
  };
}

// Effective enabled slugs — the seed/custom base plus every enabled-plugin
// convention the user hasn't turned off. Default (store absent) = all built-ins.
export async function getSelection(): Promise<string[]> {
  const { base, off } = await readSel();
  const offSet = new Set(off);
  const pluginOn = (await getCatalog())
    .filter(m => m.plugin && !offSet.has(m.slug))
    .map(m => m.slug);
  return [...new Set([...base, ...pluginOn])];
}

export async function setSelection(enabled: string[]): Promise<string[]> {
  if (!Array.isArray(enabled)) {
    throw httpError(400, 'enabled must be an array of slug strings');
  }
  const cat = await getCatalog();
  const known = new Set(cat.map(m => m.slug));
  for (const slug of enabled) {
    if (!known.has(slug)) {
      throw httpError(400, `unknown convention slug '${slug}'`);
    }
  }
  // Split the full submitted checkbox set: seed/custom slugs persist as the
  // base `enabled`; each available plugin convention drives pluginOff (checked
  // ⇒ clear the off-switch, unchecked ⇒ record it). Plugin slugs never enter
  // `enabled`, so a settings save can't freeze the seed-default set.
  const enabledSet = new Set(enabled);
  const off = new Set((await readSel()).off);
  for (const m of cat) {
    if (!m.plugin) continue;
    if (enabledSet.has(m.slug)) off.delete(m.slug);
    else off.add(m.slug);
  }
  await catalog.patchState({
    enabled: enabled.filter(s => !isPluginSlug(s)),
    pluginOff: [...off],
  });
  return enabled;
}

// ── Compose ───────────────────────────────────────────────────────────────────

// core + enabled convention bodies (catalog order) + footer.
export async function composeConduct(enabledSlugs: string[]): Promise<string> {
  const core = await getCore();
  const footer = await getFooter();
  const mods = (await catalog.compose(enabledSlugs)).trim();
  return [core, ...(mods ? [mods] : []), footer].join('\n\n') + '\n';
}

export async function composeCurrentConduct(): Promise<string> {
  return composeConduct(await getSelection());
}

// The `code`-style HTTP error the REST/MCP surfaces consume (`err.statusCode`),
// built with the same Object.assign pattern the routes use. Typed so callers
// can rely on the code without a cast.
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
