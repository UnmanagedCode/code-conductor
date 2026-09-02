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
// (e.g. the conductor/workspace scopes' `enabled` selection) are preserved
// across rule writes and exposed via readState/patchState.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './projects.ts';
import { httpError } from './httpError.ts';
import { isSlug, SLUG_RE, SLUG_MAX } from './identifiers.ts';

export function validateSlug(slug: string): string {
  if (!isSlug(slug)) {
    throw httpError(400, `invalid slug (must match ${SLUG_RE.source}, max ${SLUG_MAX} chars)`);
  }
  return slug;
}

function validateFields({ name, description, body }: { name: unknown; description: unknown; body?: unknown }, noun: string): void {
  for (const [field, val] of [['name', name], ['description', description], ['body', body]] as const) {
    if (typeof val !== 'string' || !val.trim()) {
      throw httpError(400, `${noun} ${field} is required`);
    }
  }
}

interface FragmentSeed {
  slug: string;
  name: string;
  description: string;
}

// A custom-rule record stored in the JSON store. `body` is optional because a
// rule may be written with only a scaffold facet and no markdown body.
interface CustomRule {
  slug: string;
  name: string;
  description: string;
  body?: string;
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
  [key: string]: unknown;
}

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  body?: string;
  builtin: boolean;
  // Plugin-contributed entries carry these (see conductorConventions's
  // getSelection / projectConventions's composeProjectScaffold): a namespaced
  // `plugin` id and an optional one-time scaffold directive with no body.
  plugin?: string;
  scaffold?: string;
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
  // seedDir:  absolute dir holding the built-in fragment files
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
  seedDir: string;
  seedExt?: string;
  storeFile: () => string;
  noun?: string;
  extraProvider?: (() => Promise<ExtraEntry[]>) | null;
}

// Exported so the selection collaborator (src/conventionSelection.ts) can type
// the catalog it is built on.
export interface FragmentCatalog {
  getCatalog(): Promise<CatalogList>;
  addCustom(input: { slug: string; name: string; description: string; body: string }): Promise<CatalogEntry>;
  updateCustom(slug: string, patch: { name?: unknown; description?: unknown; body?: unknown }): Promise<CatalogEntry>;
  deleteCustom(slug: string): Promise<{ slug: string }>;
  compose(slugs: string[]): Promise<string>;
  composeWithMeta(slugs: string[]): Promise<{ text: string; degraded: boolean }>;
  readState(): Promise<Record<string, unknown>>;
  patchState(patch: Record<string, unknown>): Promise<void>;
  validateSlug(slug: string): string;
}

export function createFragmentCatalog({ seeds, seedDir, seedExt = '.md', storeFile, noun = 'entry', extraProvider = null }: FragmentCatalogConfig): FragmentCatalog {
  const fragmentCache = new Map<string, string>(); // slug -> body

  async function seedBody(slug: string): Promise<string> {
    if (fragmentCache.has(slug)) return fragmentCache.get(slug) as string;
    const body = await fs.readFile(path.join(seedDir, `${slug}${seedExt}`), 'utf8');
    const trimmed = body.replace(/\s+$/, '');
    fragmentCache.set(slug, trimmed);
    return trimmed;
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

  // Normalises each stored rule to the CustomRule shape: slug is guaranteed a
  // string by the filter; name/description/body are coerced from whatever was
  // persisted. Well-formed rules (always written as strings by add/update) are
  // untouched; malformed values become '' — the same shape updateCustom's
  // re-validation expects, so a stored null can't slip through as "valid".
  async function loadCustom(): Promise<CustomRule[]> {
    const store = await loadStore();
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
      });
    }
    return out;
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
      seeds.map(async s => ({ ...s, body: await seedBody(s.slug), builtin: true })),
    );
    const custom = (await loadCustom()).map(r => ({ ...r, builtin: false }));
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

  async function addCustom(input: { slug: string; name: string; description: string; body: string }): Promise<CatalogEntry> {
    const { slug, name, description, body } = input;
    validateSlug(slug);
    validateFields({ name, description, body }, noun);
    const catalog = await getCatalog();
    if (catalog.some(r => r.slug === slug)) {
      throw httpError(409, `${noun} slug '${slug}' already exists`);
    }
    const custom = await loadCustom();
    const entry: CustomRule = { slug, name: name.trim(), description: description.trim(), body };
    custom.push(entry);
    await saveCustom(custom);
    return { ...entry, builtin: false };
  }

  async function updateCustom(slug: string, patch: { name?: unknown; description?: unknown; body?: unknown }): Promise<CatalogEntry> {
    validateSlug(slug);
    if (isSeed(slug)) {
      throw httpError(400, `cannot update built-in ${noun} '${slug}'`);
    }
    const custom = await loadCustom();
    const idx = custom.findIndex(r => r.slug === slug);
    if (idx === -1) {
      throw httpError(404, `${noun} '${slug}' not found`);
    }
    const updated: CustomRule = {
      ...custom[idx],
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.description !== undefined ? { description: String(patch.description).trim() } : {}),
      ...(patch.body !== undefined ? { body: String(patch.body) } : {}),
    };
    validateFields(updated, noun);
    custom[idx] = updated;
    await saveCustom(custom);
    return { ...updated, builtin: false };
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
  // An empty slug list still short-circuits before the catalog read, so it
  // reports `degraded: false` without consulting: a bounded under-report, and
  // the one case the flag misses — a degrade that dropped the ONLY enabled slugs
  // (every seed off plus an unreachable plugin's conventions) arrives here as an
  // empty list and goes unflagged.
  async function composeWithMeta(slugs: string[]): Promise<{ text: string; degraded: boolean }> {
    if (!Array.isArray(slugs) || slugs.length === 0) return { text: '', degraded: false };
    const catalog = await getCatalog();
    const bodies: string[] = [];
    for (const slug of slugs) {
      const entry = catalog.find(r => r.slug === slug);
      if (!entry) {
        throw httpError(400, `unknown ${noun} slug '${slug}'`);
      }
      if (entry.body) bodies.push(entry.body);
    }
    const degraded = catalog.degraded === true;
    if (bodies.length === 0) return { text: '', degraded };
    return { text: '\n' + bodies.join('\n\n') + '\n', degraded };
  }

  const compose = async (slugs: string[]): Promise<string> => (await composeWithMeta(slugs)).text;

  return {
    getCatalog, addCustom, updateCustom, deleteCustom, compose, composeWithMeta,
    readState, patchState, validateSlug,
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

