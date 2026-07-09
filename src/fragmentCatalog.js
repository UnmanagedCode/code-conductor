// Shared fragment-catalog helper.
//
// Both the optional-guideline modules (project-creation CLAUDE.md sections)
// and the conductor convention modules (composed into .conduct/CONDUCT.md)
// are "a catalog of {slug, name, description} metadata whose body is a chunk
// of markdown". Built-in bodies live in committed `.md` fragment files (one
// per slug); custom entries are created at runtime via the UI, so their body
// is stored inline in a JSON store under <orchStoreRoot>. This factory owns
// the load/CRUD/compose logic so neither feature reimplements it.
//
// The JSON store shape is { rules: [...], ...siblingKeys }. Sibling keys
// (e.g. conductModules' `enabled` selection) are preserved across rule
// writes and exposed via readState/patchState.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './projects.js';

const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const SLUG_MAX = 40;

export function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > SLUG_MAX) {
    const err = new Error('invalid slug (must match ^[a-z][a-z0-9-]*$, max 40 chars)');
    err.statusCode = 400;
    throw err;
  }
  return slug;
}

function validateFields({ name, description, body }, noun) {
  for (const [field, val] of [['name', name], ['description', description], ['body', body]]) {
    if (typeof val !== 'string' || !val.trim()) {
      const err = new Error(`${noun} ${field} is required`);
      err.statusCode = 400;
      throw err;
    }
  }
}

// seeds:    [{ slug, name, description }] — built-in metadata; body from <seedDir>/<slug>.md
// seedDir:  absolute dir holding the built-in `.md` fragments
// storeFile: () => absolute path of the custom/state JSON (lazy so PROJECTS_ROOT
//            overrides in tests are honoured per-call)
// noun:     label used in validation error messages (e.g. 'guideline', 'module')
export function createFragmentCatalog({ seeds, seedDir, storeFile, noun = 'entry' }) {
  const fragmentCache = new Map(); // slug -> body

  async function seedBody(slug) {
    if (fragmentCache.has(slug)) return fragmentCache.get(slug);
    const body = await fs.readFile(path.join(seedDir, `${slug}.md`), 'utf8');
    const trimmed = body.replace(/\s+$/, '');
    fragmentCache.set(slug, trimmed);
    return trimmed;
  }

  async function loadStore() {
    try {
      const raw = await fs.readFile(storeFile(), 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      console.warn(`fragmentCatalog: failed to read ${storeFile()}: ${e.message}`);
      return {};
    }
  }

  async function saveStore(obj) {
    await writeFileAtomic(storeFile(), JSON.stringify(obj, null, 2) + '\n');
  }

  async function loadCustom() {
    const store = await loadStore();
    if (!Array.isArray(store.rules)) return [];
    return store.rules.filter(r => r && typeof r.slug === 'string');
  }

  async function saveCustom(rules) {
    const store = await loadStore();
    await saveStore({ ...store, rules });
  }

  // Arbitrary sibling state on the same JSON store (rules preserved).
  async function readState() {
    return loadStore();
  }

  async function patchState(patch) {
    const store = await loadStore();
    await saveStore({ ...store, ...patch });
  }

  // Merged catalog: seeds (builtin:true, body from fragment) + custom (builtin:false, body from JSON).
  async function getCatalog() {
    const seedEntries = await Promise.all(
      seeds.map(async s => ({ ...s, body: await seedBody(s.slug), builtin: true })),
    );
    const custom = (await loadCustom()).map(r => ({ ...r, builtin: false }));
    return [...seedEntries, ...custom];
  }

  const isSeed = slug => seeds.some(s => s.slug === slug);

  async function addCustom({ slug, name, description, body }) {
    validateSlug(slug);
    validateFields({ name, description, body }, noun);
    const catalog = await getCatalog();
    if (catalog.some(r => r.slug === slug)) {
      const err = new Error(`${noun} slug '${slug}' already exists`);
      err.statusCode = 409;
      throw err;
    }
    const custom = await loadCustom();
    const entry = { slug, name: name.trim(), description: description.trim(), body };
    custom.push(entry);
    await saveCustom(custom);
    return { ...entry, builtin: false };
  }

  async function updateCustom(slug, { name, description, body }) {
    validateSlug(slug);
    if (isSeed(slug)) {
      const err = new Error(`cannot update built-in ${noun} '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
    const custom = await loadCustom();
    const idx = custom.findIndex(r => r.slug === slug);
    if (idx === -1) {
      const err = new Error(`${noun} '${slug}' not found`);
      err.statusCode = 404;
      throw err;
    }
    const updated = {
      ...custom[idx],
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(description !== undefined ? { description: String(description).trim() } : {}),
      ...(body !== undefined ? { body: String(body) } : {}),
    };
    validateFields(updated, noun);
    custom[idx] = updated;
    await saveCustom(custom);
    return { ...updated, builtin: false };
  }

  async function deleteCustom(slug) {
    validateSlug(slug);
    if (isSeed(slug)) {
      const err = new Error(`cannot delete built-in ${noun} '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
    const custom = await loadCustom();
    const idx = custom.findIndex(r => r.slug === slug);
    if (idx === -1) {
      const err = new Error(`${noun} '${slug}' not found`);
      err.statusCode = 404;
      throw err;
    }
    custom.splice(idx, 1);
    await saveCustom(custom);
    return { slug };
  }

  // Resolve slugs against the catalog and join their bodies. Unknown slug → 400.
  // Returns '\n' + bodies.join('\n\n') + '\n' (empty string for an empty list).
  async function compose(slugs) {
    if (!Array.isArray(slugs) || slugs.length === 0) return '';
    const catalog = await getCatalog();
    const bodies = [];
    for (const slug of slugs) {
      const entry = catalog.find(r => r.slug === slug);
      if (!entry) {
        const err = new Error(`unknown ${noun} slug '${slug}'`);
        err.statusCode = 400;
        throw err;
      }
      bodies.push(entry.body);
    }
    return '\n' + bodies.join('\n\n') + '\n';
  }

  return {
    getCatalog, addCustom, updateCustom, deleteCustom, compose,
    readState, patchState, validateSlug,
  };
}
