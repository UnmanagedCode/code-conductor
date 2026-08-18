// Conductor conventions — the toggleable sections composed alongside the
// always-on core into the conductor's role prompt, injected at spawn via
// `--append-system-prompt-file` (materialized by materializeCurrentConduct in
// src/conduct.ts; see Instance.launch/spawn in src/instances.ts).
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
// .conduct/tasks/*.md task plans and the wiki, not here. (Those are plan
// DOCUMENTS; a "playbook" is now the enforced stage graph of src/playbooks.ts.)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.ts';
import { createFragmentCatalog, type ExtraEntry } from './fragmentCatalog.ts';
import { createSelectionStore } from './conventionSelection.ts';
// Static import is safe: playbooks.ts reaches the tool registry through a lazy
// dynamic import precisely so the handlers→conductorConventions edge cannot close
// a cycle. By the time loadPlaybooks() resolves that registry, this module is
// fully initialised.
import {
  loadPlaybooks, DEFAULT_PLAYBOOK_ID,
  PLAYBOOK_ENFORCEMENT_MODES, normalizePlaybookEnforcement, type PlaybookEnforcement,
} from './playbooks.ts';
import { renderPlaybookConvention } from './playbookConvention.ts';
import { httpError } from './httpError.ts';

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
  { slug: 'playbooks', name: 'Playbooks',
    description: 'Enforced stage graphs: read the graph, carry `stage`, diagnose a stuck run' },
];

// The slug whose composed body gains the generated playbook listing below.
const PLAYBOOKS_SLUG = 'playbooks';

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

// ── Global selection (the shared collaborator + this scope's two overrides) ──
//
// A plugin's conductor conventions are ON by default the moment the plugin is
// enabled, so the only per-convention state worth persisting is the user's
// explicit OFF-switches. The selection keys in the store:
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

const pluginOffOf = (state: Record<string, unknown>): Set<string> =>
  new Set(Array.isArray(state.pluginOff) ? state.pluginOff as string[] : []);

const selection = createSelectionStore({
  catalog,
  seeds: SEED_CONVENTIONS,
  noun: 'convention',
  // Effective enabled slugs — the seed/custom base plus every enabled-plugin
  // convention the user hasn't turned off. A plugin slug that a legacy store
  // left in `enabled` is filtered out of the base and re-derived from the live
  // catalog, so it can't survive its plugin being disabled.
  derive: async ({ base, state, catalog: getCat }) => {
    const off = pluginOffOf(state);
    const pluginOn = (await getCat())
      .filter(m => m.plugin && !off.has(m.slug))
      .map(m => m.slug);
    return [...new Set([...base.filter(s => !isPluginSlug(s)), ...pluginOn])];
  },
  // Split the full submitted checkbox set: seed/custom slugs persist as the
  // base `enabled`; each available plugin convention drives pluginOff (checked
  // ⇒ clear the off-switch, unchecked ⇒ record it). Plugin slugs never enter
  // `enabled`, so a settings save can't freeze the seed-default set.
  persist: ({ submitted, state, catalog: cat }) => {
    const submittedSet = new Set(submitted);
    const off = pluginOffOf(state);
    for (const m of cat) {
      if (!m.plugin) continue;
      if (submittedSet.has(m.slug)) off.delete(m.slug);
      else off.add(m.slug);
    }
    return { enabled: submitted.filter(s => !isPluginSlug(s)), pluginOff: [...off] };
  },
});

export const getSelection = selection.getSelection;
export const setSelection = selection.setSelection;
// Deleting a custom convention also drops it from the enabled selection.
export const deleteCustomConvention = selection.deleteCustom;

// ── Compose ───────────────────────────────────────────────────────────────────

// The available playbooks, GENERATED from the definitions — id + description
// only, with the graph itself left to `describe_playbook`. Never hand-written
// alongside the definitions: a built-in whose description changes must move the
// prompt with no second edit, and a user-authored playbook must appear without
// touching this file.
//
// Empty string when nothing loads, so a broken catalog costs a heading rather
// than an empty list. Composed per call rather than cached, so it tracks the
// definitions the way the rest of the read surface does.
export async function playbookListing(): Promise<string> {
  let ids: Array<{ id: string; description: string }>;
  try {
    const { playbooks } = await loadPlaybooks();
    ids = [...playbooks.values()].map(pb => ({ id: pb.id, description: pb.description }));
  } catch (e) {
    // A definition-catalog failure must never block a conductor spawn.
    console.warn(`conductorConventions: playbook listing unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
  if (ids.length === 0) return '';
  ids.sort((a, b) => a.id.localeCompare(b.id));
  return ['**Available playbooks** — full graph via `describe_playbook({id})`:', '',
    ...ids.map(p => `- \`${p.id}\` — ${p.description}`)].join('\n');
}

// ── Preferred playbook (Settings → Conductor conventions) ───────────────────
//
// GLOBAL, like the convention selection above and for the same reason: the
// conductor is a singleton, and this value is consumed by composeCurrentConduct()
// — which takes no instance argument and runs BEFORE the instance exists (see
// materializeCurrentConduct in conduct.ts). It rides the same store as a sibling
// key, so there is no second state file and no second Settings surface.
//
// THREE states, and they are not interchangeable: never having chosen is not the
// same as having chosen nothing. Unset resolves to DEFAULT_PLAYBOOK_ID so a fresh
// install ships with a baseline graph; `none` is the explicit opt-out that keeps
// injecting nothing.
export type DefaultPlaybookSelection =
  | { mode: 'unset' }                     // never persisted — the KEY'S ABSENCE is this state
  | { mode: 'none' }
  | { mode: 'playbook'; id: string };

// Every persisted value is a tagged object, so no read site infers a state from
// null-vs-string-vs-empty. Absence is unset because a fresh install has no file
// to have written. Migration 0028 converts the pre-tri-state shape.
export async function getDefaultPlaybookSelection(): Promise<DefaultPlaybookSelection> {
  const v = (await catalog.readState()).defaultPlaybook;
  if (v === undefined) return { mode: 'unset' };
  const mode = (v as { mode?: unknown } | null)?.mode;
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'playbook') {
    const id = (v as { id?: unknown }).id;
    if (typeof id === 'string' && id) return { mode: 'playbook', id };
  }
  console.warn(`conductorConventions: unrecognised defaultPlaybook value ${JSON.stringify(v)}; reading as unset`);
  return { mode: 'unset' };
}

// THE resolution path, and the only home of the fallback.
export async function resolveDefaultPlaybookId(): Promise<string | null> {
  const sel = await getDefaultPlaybookSelection();
  if (sel.mode === 'playbook') return sel.id;
  return sel.mode === 'unset' ? DEFAULT_PLAYBOOK_ID : null;
}

// A `playbook` id is validated against the LOADED definitions — built-ins plus
// the user overlay, through the one catalog in playbooks.ts. A selection that no
// definition backs would silently render nothing.
export async function setDefaultPlaybook(sel: DefaultPlaybookSelection): Promise<DefaultPlaybookSelection> {
  const mode = (sel as { mode?: unknown } | null)?.mode;
  if (mode === 'unset') {
    // undefined, not null: JSON.stringify drops the key, and absence IS unset.
    await catalog.patchState({ defaultPlaybook: undefined });
    return { mode: 'unset' };
  }
  if (mode === 'none') {
    await catalog.patchState({ defaultPlaybook: { mode: 'none' } });
    return { mode: 'none' };
  }
  if (mode !== 'playbook') {
    throw httpError(400, "mode must be one of 'unset', 'none', 'playbook'");
  }
  const id = (sel as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) {
    throw httpError(400, "mode 'playbook' requires an id");
  }
  const { playbooks } = await loadPlaybooks();
  if (!playbooks.has(id)) {
    throw httpError(400, `unknown playbook id '${id}' (known: ${[...playbooks.keys()].sort().join(', ') || '(none)'})`);
  }
  await catalog.patchState({ defaultPlaybook: { mode: 'playbook', id } });
  return { mode: 'playbook', id };
}

// ── Default playbook enforcement (same Settings block, same store) ──────────
//
// Global for the same reason the selection above is (see the note at the top of
// that block). This is the level a NEWLY SPAWNED conductor starts at, applied in
// Manager._doCreate; the ⋮ toggle overrides it for one session and never writes
// back here.
//
// TWO states, not three: an unset key and an explicit 'enforce' behave
// identically, so there is no "default" row to distinguish.
export async function getDefaultPlaybookEnforcement(): Promise<PlaybookEnforcement> {
  // normalizePlaybookEnforcement owns both the absent→DEFAULT fallback and the
  // retired-'off'→'warn' rule; this read site adds neither.
  return normalizePlaybookEnforcement((await catalog.readState()).defaultPlaybookEnforcement);
}

export async function setDefaultPlaybookEnforcement(mode: unknown): Promise<PlaybookEnforcement> {
  // Validated against the allow-list rather than the normalizer: 'off' is
  // readable (legacy tolerance) but must never be writable.
  if (typeof mode !== 'string' || !(PLAYBOOK_ENFORCEMENT_MODES as readonly string[]).includes(mode)) {
    throw httpError(400, `mode must be one of ${PLAYBOOK_ENFORCEMENT_MODES.join(' | ')}`);
  }
  await catalog.patchState({ defaultPlaybookEnforcement: mode });
  return mode as PlaybookEnforcement;
}

// The resolved preferred playbook, GENERATED from its definition (see
// playbookConvention.ts). Empty string on the explicit opt-out, when the
// selection no longer resolves, or when the catalog fails to load — a spawn must
// never be blocked by this section.
export async function defaultPlaybookConvention(): Promise<string> {
  const id = await resolveDefaultPlaybookId();
  if (!id) return '';
  try {
    const { playbooks } = await loadPlaybooks();
    const pb = playbooks.get(id);
    if (!pb) {
      console.warn(`conductorConventions: preferred playbook '${id}' is not loaded; omitting its convention`);
      return '';
    }
    return renderPlaybookConvention(pb);
  } catch (e) {
    console.warn(`conductorConventions: preferred playbook unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

// core + enabled convention bodies (catalog order) + footer.
export async function composeConduct(enabledSlugs: string[]): Promise<string> {
  const core = await getCore();
  const footer = await getFooter();
  let mods = (await catalog.compose(enabledSlugs)).trim();
  // Both generated sections ride the playbooks convention, so a session with
  // that convention off pays nothing for them.
  //
  // ORDER IS LOAD-BEARING, and pinned by a test: the preferred-playbook section
  // omits its playbook's description and a describe_playbook pointer BECAUSE the
  // listing carries both. Met first, it would cost the conductor the round-trip
  // that section exists to remove. Don't reorder, and don't insert between them.
  if (mods && enabledSlugs.includes(PLAYBOOKS_SLUG)) {
    for (const section of [await playbookListing(), await defaultPlaybookConvention()]) {
      if (section) mods = `${mods}\n\n${section}`;
    }
  }
  return [core, ...(mods ? [mods] : []), footer].join('\n\n') + '\n';
}

export async function composeCurrentConduct(): Promise<string> {
  return composeConduct(await getSelection());
}

