// Shared fragment-catalog helper.
//
// The convention scopes (a project's own conventions, the workspace ones
// composed above them, and the conductor role prompt)
// are each "a catalog of {slug, name, description} metadata whose body is a
// chunk of markdown". Built-in bodies live in committed `.md` fragment files
// (one per slug); custom entries are created at runtime via the UI, so their
// body is stored inline in a JSON store under <orchStoreRoot>. This factory
// owns the load/CRUD/compose logic so no scope reimplements it.
//
// The JSON store shape is { rules: [...], ...siblingKeys }. Sibling keys
// (e.g. the conductor/workspace scopes' `disabled` selection) are preserved
// across rule writes and exposed via readState/patchState.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './projects.ts';
import { httpError } from './httpError.ts';
import { isSlug, SLUG_RE, SLUG_MAX } from './identifiers.ts';
import { splitSkillPart, type SkillPart, type SplitFragment } from '../shared/skillPart.ts';

export function validateSlug(slug: string): string {
  if (!isSlug(slug)) {
    throw httpError(400, `invalid slug (must match ${SLUG_RE.source}, max ${SLUG_MAX} chars)`);
  }
  return slug;
}

// One skill a composed selection delivers: `name` is the seed slug, the
// custom slug, the plugin-local slug (the part after `<plugin>/`), or a core's
// explicit name. `custom` marks a Settings-authored convention's skill, which
// is delivered under its own namespace (src/conventionSkills.ts).
export interface ConventionSkill {
  name: string;
  plugin?: string;
  custom?: true;
  description: string;
  body: string;
}

// The skills of `slugs` (in order, each once) over an ALREADY-READ catalog —
// pure, so a caller holding a catalog derives them off the read its text came
// from. A slug the catalog lacks contributes nothing here; composeWithMeta's
// unknown-slug 400 is the caller's to raise.
export function skillsOf(catalog: CatalogEntry[], slugs: string[]): ConventionSkill[] {
  const out: ConventionSkill[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const entry = catalog.find(r => r.slug === slug);
    if (!entry?.skill) continue;
    const name = entry.plugin ? slug.slice(entry.plugin.length + 1) : slug;
    const custom = !entry.builtin && !entry.plugin;
    out.push({ name, ...(entry.plugin ? { plugin: entry.plugin } : {}), ...(custom ? { custom: true as const } : {}), description: entry.skill.description, body: entry.skill.body });
  }
  return out;
}

// A scope's always-on core file, split. Its skill (if any) names itself — a
// core has no slug — and that name may not equal a seed slug of the same scope,
// which would put two skills of one name in the scope's namespace. Throws,
// naming the file, on either a malformed marker or a clash.
export async function readCoreFragment(file: string, seedSlugs: string[]): Promise<{ inline: string; skill?: ConventionSkill }> {
  const raw = await fs.readFile(file, 'utf8');
  let split: SplitFragment;
  try { split = splitSkillPart(raw, { explicitName: 'required' }); }
  catch (e) { throw new Error(`${file}: ${errMsg(e)}`); }
  if (!split.skill) return { inline: split.inline };
  const name = split.skill.name as string;
  if (seedSlugs.includes(name)) {
    throw new Error(`${file}: core skill name '${name}' is also a seed slug of this scope — the two skills would share one name`);
  }
  return { inline: split.inline, skill: { name, description: split.skill.description, body: split.skill.body } };
}

const isFilled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

// name and description are always required; the body is required unless a
// non-empty scaffold stands in for it (a scaffold-only convention).
function validateFields({ name, description, body, scaffold }: { name: unknown; description: unknown; body?: unknown; scaffold?: unknown }, noun: string): void {
  for (const [field, val] of [['name', name], ['description', description]] as const) {
    if (!isFilled(val)) throw httpError(400, `${noun} ${field} is required`);
  }
  if (!isFilled(body) && !isFilled(scaffold)) throw httpError(400, `${noun} body is required`);
}

// Normalises a store's `rules` array to the CustomRule shape: slug is
// guaranteed a string by the filter; name/description/body are coerced from
// whatever was persisted. Well-formed rules (always written as strings by
// add/update) are untouched; malformed values become '' — the same shape
// updateCustom's re-validation expects, so a stored null can't slip through as
// "valid".
//
// Pure and I/O-free, so it serves both loadCustom (which reads the store) and
// customSlugsOf (which is handed state the caller already read) off ONE
// definition of the store shape.
function normalizeRules(store: Record<string, unknown>): CustomRule[] {
  if (!Array.isArray(store.rules)) return [];
  const out: CustomRule[] = [];
  for (const r of store.rules) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.slug !== 'string') continue;
    out.push({
      slug: rec.slug,
      name: typeof rec.name === 'string' ? rec.name : '',
      description: typeof rec.description === 'string' ? rec.description : '',
      body: typeof rec.body === 'string' ? rec.body : undefined,
      ...(isFilled(rec.scaffold) ? { scaffold: rec.scaffold } : {}),
    });
  }
  return out;
}

interface FragmentSeed {
  slug: string;
  name: string;
  description: string;
}

// A custom-rule record stored in the JSON store. `body` is the text as authored
// (a `skillParts` catalog splits it at the skill marker on read) and is optional
// because a rule may be written with only a scaffold facet and no markdown body.
// `scaffold` is stored by a `scaffolds` catalog only.
interface CustomRule {
  slug: string;
  name: string;
  description: string;
  body?: string;
  scaffold?: string;
}

// An entry a third source (extraProvider, e.g. an enabled plugin's convention
// fragments) contributes to the merged catalog. Exported so the convention
// scopes can type their providers without a local copy.
export interface ExtraEntry {
  slug: string;
  name: string;
  description: string;
  body?: string;
  scaffold?: string;
  plugin?: string;
  skill?: SkillPart;
  [key: string]: unknown;
}

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  body?: string;
  builtin: boolean;
  // `plugin` is a plugin-contributed entry's namespaced id. `scaffold` is an
  // optional one-time scaffold directive (a plugin's, or a custom project
  // convention's); see projectConventions's composeProjectScaffold.
  plugin?: string;
  scaffold?: string;
  // The skill part (splitSkillPart), when there is one: a seed of a
  // `skillParts` catalog, a plugin fragment file, or a custom body of a
  // `skillParts` catalog. `body` is then the inline part.
  skill?: SkillPart;
  // Custom entries of a `skillParts` catalog only: `source` is the text as
  // stored — what the Settings editor edits, since `body` is only the inline
  // part. `skillError` is set when the stored text has a marker that does not
  // parse; `body` is then the whole stored text, unsplit.
  source?: string;
  skillError?: string;
}

// `degraded: true` means a plugin-contributed slug may be MISSING from this
// list because cc could not establish what that plugin contributes — three
// causes: the extraProvider threw outright, a plugin's own cwd resolution
// failed, or the last discovery scan could not reach the project an enabled
// plugin lives in (so its manifest was never read and the plugin is not in the
// catalog at all; that one stands until a rescan rebuilds the catalog, or the
// plugin it flags on is disabled). NOT a vanished
// fragment/scaffold file, which is a different, already-accepted case that just
// contributes nothing — and not because it is genuinely absent/disabled. A
// caller that treats "not in the catalog" as "safe to drop" (e.g.
// ensureProjectConventionsMd's never-blanks gate) must check this first: a
// degraded catalog can't tell "gone" from "temporarily unreachable" for a slug
// about to be dropped.
export type CatalogList = CatalogEntry[] & { degraded?: boolean };

interface FragmentCatalogConfig {
  // seeds:    [{ slug, name, description }] — built-in metadata; body from <seedDir>/<slug><seedExt>
  // seedDir:  absolute dir holding the built-in fragment files, or a function
  //           returning it (read per call, like storeFile)
  // skillParts: split each seed body with splitSkillPart (the convention
  //           scopes); off for a catalog whose seeds are not markdown fragments
  // seedExt:  seed filename extension, default '.md' (the playbook catalog passes
  //           '.json' — its bodies are JSON definitions the caller parses itself)
  // storeFile: () => absolute path of the custom/state JSON (lazy so PROJECTS_ROOT
  //            overrides in tests are honoured per-call)
  // noun:     label used in validation error messages (e.g. 'convention')
  // extraProvider: optional async () => [{ slug, name, description, body, ...meta }]
  //            — a third body source merged after seeds+custom (e.g. enabled
  //            plugins' convention fragments). Entries are read-only (builtin:false)
  //            and bypass the custom-store CRUD; their slugs are namespaced by the
  //            provider so they never collide with seed/custom slugs.
  seeds: FragmentSeed[];
  seedDir: string | (() => string);
  seedExt?: string;
  skillParts?: boolean;
  // scaffolds: custom entries may carry a one-time `scaffold` directive (the
  //           project scope only); any other catalog refuses one with 400
  scaffolds?: boolean;
  storeFile: () => string;
  noun?: string;
  extraProvider?: (() => Promise<ExtraEntry[]>) | null;
}

// Exported so the selection collaborator (src/conventionSelection.ts) can type
// the catalog it is built on.
export interface FragmentCatalog {
  getCatalog(): Promise<CatalogList>;
  addCustom(input: { slug: string; name: string; description: string; body?: unknown; scaffold?: unknown }): Promise<CatalogEntry>;
  updateCustom(slug: string, patch: { name?: unknown; description?: unknown; body?: unknown; scaffold?: unknown }): Promise<CatalogEntry>;
  deleteCustom(slug: string): Promise<{ slug: string }>;
  compose(slugs: string[]): Promise<string>;
  composeWithMeta(slugs: string[]): Promise<{ text: string; degraded: boolean; skills: ConventionSkill[] }>;
  readState(): Promise<Record<string, unknown>>;
  patchState(patch: Record<string, unknown>): Promise<void>;
  // The custom-entry slugs of an ALREADY-READ state — pure, no I/O. The
  // selection collaborator builds its base from it (seeds ∪ customs − off) off
  // the single readState() it already makes, without resolving the catalog (and
  // so without re-reading every seed fragment off disk).
  customSlugsOf(state: Record<string, unknown>): string[];
  validateSlug(slug: string): string;
}

export function createFragmentCatalog({ seeds, seedDir, seedExt = '.md', skillParts = false, scaffolds = false, storeFile, noun = 'entry', extraProvider = null }: FragmentCatalogConfig): FragmentCatalog {
  const seedDirNow = (): string => typeof seedDir === 'function' ? seedDir() : seedDir;
  // Read per call, never memoised: an edit to a committed fragment must reach
  // the next composition without an orchestrator restart. A memo here does not
  // merely go stale — every document these bodies feed is REGENERATED OVER a
  // committed file, so the pre-edit text gets written back and the edit
  // silently reverts. Cost is measured and stated in docs/architecture.md →
  // src/fragmentCatalog.ts.
  // A seed whose file carries a malformed skill marker throws, naming the file:
  // a shipped fragment is never composed half-parsed.
  async function seedEntry(slug: string): Promise<{ body: string; skill?: SkillPart }> {
    const file = path.join(seedDirNow(), `${slug}${seedExt}`);
    const raw = await fs.readFile(file, 'utf8');
    if (!skillParts) return { body: raw.replace(/\s+$/, '') };
    let split: SplitFragment;
    try { split = splitSkillPart(raw); }
    catch (e) { throw new Error(`${file}: ${errMsg(e)}`); }
    return { body: split.inline, ...(split.skill ? { skill: split.skill } : {}) };
  }

  // A custom body's split. Writes validate, so a marker that does not parse
  // came from before the feature or a hand edit; it stays whole and inline with
  // the reason in `skillError` rather than dropping the entry (a custom slug
  // enters the selections from the store, so a missing entry would make every
  // compose 400).
  function customEntry(r: CustomRule): CatalogEntry {
    const base = { slug: r.slug, name: r.name, description: r.description, builtin: false, ...(r.scaffold ? { scaffold: r.scaffold } : {}) };
    if (!skillParts || r.body === undefined) return { ...base, body: r.body };
    try {
      const split = splitSkillPart(r.body);
      return { ...base, source: r.body, body: split.skill ? split.inline : r.body, ...(split.skill ? { skill: split.skill } : {}) };
    } catch (e) {
      console.warn(`fragmentCatalog: ${storeFile()}: custom ${noun} '${r.slug}': ${errMsg(e)}`);
      return { ...base, source: r.body, body: r.body, skillError: errMsg(e) };
    }
  }

  // The write-side twin of customEntry's read: a marker that does not parse is
  // refused, as manifest load refuses a plugin's.
  function checkBody(body: unknown): void {
    if (!skillParts || typeof body !== 'string') return;
    try { splitSkillPart(body); }
    catch (e) { throw httpError(400, `${noun} body: ${errMsg(e)}`); }
  }

  // A body, when given, is a string: never coerced into one.
  function requireStringBody(v: unknown): void {
    if (v !== undefined && typeof v !== 'string') throw httpError(400, `${noun} body must be a string`);
  }

  // The stored scaffold of a write: '' or undefined removes it, a string is
  // trimmed, anything else is refused. A catalog without `scaffolds` refuses a
  // non-empty one.
  function scaffoldValue(v: unknown): string {
    if (v !== undefined && typeof v !== 'string') throw httpError(400, `${noun} scaffold must be a string`);
    const t = v === undefined ? '' : v.trim();
    if (t && !scaffolds) throw httpError(400, 'scaffolds are project-scope only');
    return t;
  }

  async function loadStore(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(storeFile(), 'utf8');
      const obj: unknown = JSON.parse(raw);
      return typeof obj === 'object' && obj !== null ? obj as Record<string, unknown> : {};
    } catch (e) {
      if (errCode(e) === 'ENOENT') return {};
      console.warn(`fragmentCatalog: failed to read ${storeFile()}: ${errMsg(e)}`);
      return {};
    }
  }

  async function saveStore(obj: Record<string, unknown>): Promise<void> {
    await writeFileAtomic(storeFile(), JSON.stringify(obj, null, 2) + '\n');
  }

  async function loadCustom(): Promise<CustomRule[]> {
    return normalizeRules(await loadStore());
  }

  async function saveCustom(rules: CustomRule[]): Promise<void> {
    const store = await loadStore();
    await saveStore({ ...store, rules });
  }

  // Arbitrary sibling state on the same JSON store (rules preserved).
  async function readState(): Promise<Record<string, unknown>> {
    return loadStore();
  }

  async function patchState(patch: Record<string, unknown>): Promise<void> {
    const store = await loadStore();
    await saveStore({ ...store, ...patch });
  }

  // Merged catalog: seeds (builtin:true, body from fragment) + custom
  // (builtin:false, body from JSON) + optional extraProvider entries (builtin:false).
  // `degraded` (see CatalogList) is set when extraProvider failed outright, or
  // flagged the list it DID return as incomplete (see registry.ts's `conventions()`).
  async function getCatalog(): Promise<CatalogList> {
    const seedEntries = await Promise.all(
      seeds.map(async s => ({ ...s, ...await seedEntry(s.slug), builtin: true })),
    );
    const custom = (await loadCustom()).map(customEntry);
    let extra: CatalogEntry[] = [];
    let degraded = false;
    if (extraProvider) {
      try {
        const raw = await extraProvider();
        if ((raw as ExtraEntry[] & { degraded?: boolean }).degraded) degraded = true;
        extra = raw.map(r => ({ ...r, builtin: false }));
      }
      catch (e) { degraded = true; console.warn(`fragmentCatalog: extraProvider failed: ${errMsg(e)}`); }
    }
    return Object.assign([...seedEntries, ...custom, ...extra], { degraded });
  }

  const isSeed = (slug: string): boolean => seeds.some(s => s.slug === slug);

  async function addCustom(input: { slug: string; name: string; description: string; body?: unknown; scaffold?: unknown }): Promise<CatalogEntry> {
    const { slug, name, description, body } = input;
    validateSlug(slug);
    const scaffold = scaffoldValue(input.scaffold);
    requireStringBody(body);
    validateFields({ name, description, body, scaffold }, noun);
    checkBody(body);
    const catalog = await getCatalog();
    if (catalog.some(r => r.slug === slug)) {
      throw httpError(409, `${noun} slug '${slug}' already exists`);
    }
    const custom = await loadCustom();
    const entry: CustomRule = { slug, name: name.trim(), description: description.trim(), body: (body as string | undefined) ?? '', ...(scaffold ? { scaffold } : {}) };
    custom.push(entry);
    await saveCustom(custom);
    return customEntry(entry);
  }

  async function updateCustom(slug: string, patch: { name?: unknown; description?: unknown; body?: unknown; scaffold?: unknown }): Promise<CatalogEntry> {
    validateSlug(slug);
    if (isSeed(slug)) {
      throw httpError(400, `cannot update built-in ${noun} '${slug}'`);
    }
    const custom = await loadCustom();
    const idx = custom.findIndex(r => r.slug === slug);
    if (idx === -1) {
      throw httpError(404, `${noun} '${slug}' not found`);
    }
    requireStringBody(patch.body);
    const { scaffold: kept, ...rest } = custom[idx];
    const scaffold = patch.scaffold !== undefined ? scaffoldValue(patch.scaffold) : kept ?? '';
    const updated: CustomRule = {
      ...rest,
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.description !== undefined ? { description: String(patch.description).trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body as string } : {}),
      ...(scaffold ? { scaffold } : {}),
    };
    validateFields(updated, noun);
    if (patch.body !== undefined) checkBody(updated.body);
    custom[idx] = updated;
    await saveCustom(custom);
    return customEntry(updated);
  }

  async function deleteCustom(slug: string): Promise<{ slug: string }> {
    validateSlug(slug);
    if (isSeed(slug)) {
      throw httpError(400, `cannot delete built-in ${noun} '${slug}'`);
    }
    const custom = await loadCustom();
    const idx = custom.findIndex(r => r.slug === slug);
    if (idx === -1) {
      throw httpError(404, `${noun} '${slug}' not found`);
    }
    custom.splice(idx, 1);
    await saveCustom(custom);
    return { slug };
  }

  // Resolve slugs against the catalog and join their bodies. Unknown slug → 400.
  // Entries without a fragment body (e.g. a plugin convention that carries only
  // a scaffold facet) contribute nothing. Returns '\n' + bodies.join('\n\n') +
  // '\n' (empty string when no slugs or no surviving bodies).
  //
  // Returned WITH the catalog's `degraded` flag, off the same getCatalog() call
  // this already makes, because degradedness is a property OF THIS TEXT: a
  // degrade only ever OMITS catalog entries, so a caller holding the text needs
  // the flag to know whether an absence in it was established or merely
  // unvouchable (card 2026-0277 — the conductor role doc consulted nothing and
  // rendered the two identically). A separate accessor would invite reading one
  // without the other, which is that same defect one layer down.
  //
  // The catalog is read BEFORE the empty-list guard, so an empty list reports
  // the real flag instead of a hardcoded false. An empty list is itself
  // something a degrade CAUSES: with every seed convention off, the only
  // enabled slugs can all be contributed by one plugin, and an outage on that
  // plugin's project collapses the list to nothing — the arm that loses 100% of
  // the enabled bodies, and so the last one that can afford to be blind. Cost,
  // counted: every non-empty call (which is every conductor launch) still makes
  // exactly one getCatalog(); only the empty-list path gains one.
  //
  // `skills` (skillsOf) comes off the SAME catalog read and the same slugs as
  // `text`, so a selection can never deliver one part without the other.
  async function composeWithMeta(slugs: string[]): Promise<{ text: string; degraded: boolean; skills: ConventionSkill[] }> {
    const catalog = await getCatalog();
    const degraded = catalog.degraded === true;
    if (!Array.isArray(slugs) || slugs.length === 0) return { text: '', degraded, skills: [] };
    const bodies: string[] = [];
    for (const slug of slugs) {
      const entry = catalog.find(r => r.slug === slug);
      if (!entry) {
        throw httpError(400, `unknown ${noun} slug '${slug}'`);
      }
      if (entry.body) bodies.push(entry.body);
    }
    const skills = skillsOf(catalog, slugs);
    if (bodies.length === 0) return { text: '', degraded, skills };
    return { text: '\n' + bodies.join('\n\n') + '\n', degraded, skills };
  }

  const compose = async (slugs: string[]): Promise<string> => (await composeWithMeta(slugs)).text;

  const customSlugsOf = (state: Record<string, unknown>): string[] =>
    normalizeRules(state).map(r => r.slug);

  return {
    getCatalog, addCustom, updateCustom, deleteCustom, compose, composeWithMeta,
    readState, patchState, customSlugsOf, validateSlug,
  };
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

