// Optional guideline modules — a catalog of named CLAUDE.md sections that can be
// appended inline to a new project's CLAUDE.md at creation time.
//
// Seeds are read-only (builtin: true) and ship with the app.
// Custom guidelines (builtin: false) are persisted at <orchStoreRoot>/optional-guidelines.json.
// The merged catalog is the source of truth for both the REST API and MCP surface.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic } from './projects.js';

// ── Seed guidelines ───────────────────────────────────────────────────────────

export const SEED_GUIDELINES = [
  {
    slug: 'design-guidelines',
    name: 'Design guidelines',
    description: 'No god-modules; single source of truth; thin bootstrap; shared service layer',
    body: `## Design guidelines
- One responsibility per module — when a module takes on a second concern, extract it as a composed collaborator behind a stable interface; no god-modules.
- Single source of truth — shared catalogs, config, and constants live in one authoritative place and are read from there; never duplicate them (a startup/first-paint fallback is fine — it's a fallback, not a second source).
- Keep wiring thin — entry/bootstrap code builds state and calls each feature's init once; feature logic lives in its own module, not the entry point.
- Share one implementation across surfaces — when the same logic backs multiple interfaces (e.g. an HTTP API and a CLI/MCP tool), write it once and import it from both; never reimplement per surface.
- Depend on stable interfaces, not internals — collaborators talk through narrow, documented surfaces so either side can change independently.
- Fail loudly, not silently — surface errors with context; reserve fallbacks for genuine, logged degradations.`,
    builtin: true,
  },
  {
    slug: 'testing-guidelines',
    name: 'Testing guidelines',
    description: 'Prefer automated tests over manual checklists; deterministic; isolated; fake external deps',
    body: `## Testing guidelines
- Prefer automated tests over manual verification checklists — write runnable proof, not a script to follow by hand.
- Tests must be deterministic and fast: no long real sleeps, no live network, no wall-clock dependence. Use short timeouts and fake/injected clocks, and assert on the killed/cancelled outcome rather than waiting out a delay.
- Isolate state: each test sets up and tears down its own fixtures (fresh temp dirs, no shared globals) so tests pass in any order.
- For expensive/external systems (a real CLI or API), build a small fake emitting canned output and inject it via env var; keep one real-dependency smoke test gated behind an env flag (e.g. \`RUN_REAL_X=1\`).
- Use the language's built-in test runner unless the project already uses another framework; avoid adding dependencies.
- In plan files, use an "Integration tests" section listing the actual test files, what they cover, and the run command — not a "Manual verification" section.
- Run tests as the last implementation step and report pass/fail; don't ask the user to verify by hand.`,
    builtin: true,
  },
  {
    slug: 'documentation-guidelines',
    name: 'Documentation guidelines',
    description: 'Layered docs (README + docs/features/protocol/architecture); update the most-specific file when behavior changes',
    body: `## Documentation guidelines
Layer docs; on any behavior change, update the most specific file — not just the README.
- \`docs/features.md\` — user-facing features, UI, new tools.
- \`docs/protocol.md\` — interface contracts: endpoints, message types, protocol flags, wire formats.
- \`docs/architecture.md\` — internals: components, lifecycle, on-disk state, migrations, test patterns.
- \`README.md\` — overview, quick start, key defaults, known limitations; add a one-line note here only when a change adds a new top-level subsystem.
Be precise: name exact paths, commands, flags, and defaults; prefer bullets/tables over prose; keep functional and technical descriptions in sync.`,
    builtin: true,
  },
];

// ── Persistence ───────────────────────────────────────────────────────────────

function customGuidelinesFile() {
  return path.join(orchStoreRoot(), 'optional-guidelines.json');
}

async function loadCustomGuidelines() {
  try {
    const raw = await fs.readFile(customGuidelinesFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.rules)) return [];
    return obj.rules.filter(r => r && typeof r.slug === 'string');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn(`optionalGuidelines: failed to read ${customGuidelinesFile()}: ${e.message}`);
    return [];
  }
}

async function saveCustomGuidelines(guidelines) {
  await writeFileAtomic(customGuidelinesFile(), JSON.stringify({ rules: guidelines }, null, 2) + '\n');
}

// ── Catalog ───────────────────────────────────────────────────────────────────

// Returns the merged catalog: SEED_GUIDELINES (builtin:true) + custom guidelines (builtin:false).
// Each entry: { slug, name, description, body, builtin }.
export async function getCatalog() {
  const custom = await loadCustomGuidelines();
  return [
    ...SEED_GUIDELINES,
    ...custom.map(r => ({ ...r, builtin: false })),
  ];
}

// ── Validation ────────────────────────────────────────────────────────────────

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

function validateGuidelineFields({ name, description, body }) {
  if (typeof name !== 'string' || !name.trim()) {
    const err = new Error('guideline name is required');
    err.statusCode = 400;
    throw err;
  }
  if (typeof description !== 'string' || !description.trim()) {
    const err = new Error('guideline description is required');
    err.statusCode = 400;
    throw err;
  }
  if (typeof body !== 'string' || !body.trim()) {
    const err = new Error('guideline body is required');
    err.statusCode = 400;
    throw err;
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function addCustomGuideline({ slug, name, description, body }) {
  validateSlug(slug);
  validateGuidelineFields({ name, description, body });
  const catalog = await getCatalog();
  if (catalog.some(r => r.slug === slug)) {
    const err = new Error(`guideline slug '${slug}' already exists`);
    err.statusCode = 409;
    throw err;
  }
  const custom = await loadCustomGuidelines();
  custom.push({ slug, name: name.trim(), description: description.trim(), body });
  await saveCustomGuidelines(custom);
  return { slug, name: name.trim(), description: description.trim(), body, builtin: false };
}

export async function updateCustomGuideline(slug, { name, description, body }) {
  validateSlug(slug);
  if (SEED_GUIDELINES.some(r => r.slug === slug)) {
    const err = new Error(`cannot update built-in guideline '${slug}'`);
    err.statusCode = 400;
    throw err;
  }
  const custom = await loadCustomGuidelines();
  const idx = custom.findIndex(r => r.slug === slug);
  if (idx === -1) {
    const err = new Error(`guideline '${slug}' not found`);
    err.statusCode = 404;
    throw err;
  }
  const updated = {
    ...custom[idx],
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(description !== undefined ? { description: String(description).trim() } : {}),
    ...(body !== undefined ? { body: String(body) } : {}),
  };
  validateGuidelineFields(updated);
  custom[idx] = updated;
  await saveCustomGuidelines(custom);
  return { ...updated, builtin: false };
}

export async function deleteCustomGuideline(slug) {
  validateSlug(slug);
  if (SEED_GUIDELINES.some(r => r.slug === slug)) {
    const err = new Error(`cannot delete built-in guideline '${slug}'`);
    err.statusCode = 400;
    throw err;
  }
  const custom = await loadCustomGuidelines();
  const idx = custom.findIndex(r => r.slug === slug);
  if (idx === -1) {
    const err = new Error(`guideline '${slug}' not found`);
    err.statusCode = 404;
    throw err;
  }
  custom.splice(idx, 1);
  await saveCustomGuidelines(custom);
  return { slug };
}

// ── Compose ───────────────────────────────────────────────────────────────────

// Resolves an array of slugs against the catalog and returns the markdown block
// to append after `@../CLAUDE.md\n` in a new project's CLAUDE.md.
// Unknown slugs produce a 400 error. Empty array → '' (no append).
export async function composeGuidelinesBlock(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return '';
  const catalog = await getCatalog();
  const bodies = [];
  for (const slug of slugs) {
    const guideline = catalog.find(r => r.slug === slug);
    if (!guideline) {
      const err = new Error(`unknown guideline slug '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
    bodies.push(guideline.body);
  }
  return '\n' + bodies.join('\n\n') + '\n';
}
