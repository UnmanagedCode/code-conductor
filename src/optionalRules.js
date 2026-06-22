// Optional rule modules — a catalog of named CLAUDE.md sections that can be
// appended inline to a new project's CLAUDE.md at creation time.
//
// Seeds are read-only (builtin: true) and ship with the app.
// Custom rules (builtin: false) are persisted at <orchStoreRoot>/optional-rules.json.
// The merged catalog is the source of truth for both the REST API and MCP surface.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic } from './projects.js';

// ── Seed rules ────────────────────────────────────────────────────────────────

export const SEED_RULES = [
  {
    slug: 'testing-conventions',
    name: 'Testing conventions',
    description: 'Prefer automated integration tests; built-in runner; fake external deps',
    body: `## Testing conventions
- Prefer automated integration tests over manual verification checklists — write runnable proof, not a script to follow by hand.
- In plan files, use an "Integration tests" section listing the actual test files, what they cover, and the command to run them — not a "Manual verification" section.
- Use the language's built-in test runner (e.g. Node's \`node:test\` + \`node:assert\`) unless the project already uses another framework; avoid adding dependencies.
- For tests that would hit expensive/external systems (a real CLI or API), build a small fake emitting canned output and inject it via env var; keep one real-dependency smoke test gated behind an env flag (e.g. \`RUN_REAL_X=1\`).
- Run tests as the last implementation step and report pass/fail rather than asking the user to click through the UI.`,
    builtin: true,
  },
  {
    slug: 'design-principles',
    name: 'Design principles',
    description: 'No god-modules; single source of truth; thin bootstrap; shared service layer',
    body: `## Design principles
- No god-modules — when a module takes on a second responsibility, extract it as a composed collaborator with a stable delegating surface.
- Single source of truth for shared catalogs/config — the authoritative list lives in one place and is fetched by consumers; never duplicate it as client-side literals (a first-paint fallback is fine).
- Keep bootstrap thin — entry/wiring code builds state + wiring and calls each feature's init once; feature logic lives in its own module.
- Share one service layer across surfaces — when the same logic backs multiple interfaces (e.g. REST + MCP), implement it once and import it from both.`,
    builtin: true,
  },
  {
    slug: 'doc-hygiene',
    name: 'Documentation hygiene',
    description: 'Layered docs (README + docs/features/protocol/architecture); update the most-specific file when behavior changes',
    body: `## Documentation hygiene
Keep docs layered, and on any behavior change update the most specific file — not just the README.
- \`README.md\` — overview (functional + technical), quick start, key defaults, known limitations. The entry point.
- \`docs/features.md\` — user-facing features and UI behavior.
- \`docs/protocol.md\` — external interface contracts: API/REST endpoints, message types, protocol flags, wire formats.
- \`docs/architecture.md\` — internals: component layout, lifecycle, on-disk state, migrations, testing patterns.

Route each change to the right file:
- User-facing feature / UI / new tool → \`docs/features.md\` (+ a one-line README note only if it adds a new top-level subsystem).
- New/changed endpoint, message type, or protocol flag → \`docs/protocol.md\`.
- New source file, wiring, lifecycle/state/migration/test-pattern change → \`docs/architecture.md\`.
- Quick-start step, key default, or known limitation → \`README.md\` directly.

Keep functional and technical descriptions in sync; be precise — name exact paths, commands, flags, and defaults, and prefer bullets/tables for enumerable facts.`,
    builtin: true,
  },
];

// ── Persistence ───────────────────────────────────────────────────────────────

function customRulesFile() {
  return path.join(orchStoreRoot(), 'optional-rules.json');
}

async function loadCustomRules() {
  try {
    const raw = await fs.readFile(customRulesFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.rules)) return [];
    return obj.rules.filter(r => r && typeof r.slug === 'string');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn(`optionalRules: failed to read ${customRulesFile()}: ${e.message}`);
    return [];
  }
}

async function saveCustomRules(rules) {
  await writeFileAtomic(customRulesFile(), JSON.stringify({ rules }, null, 2) + '\n');
}

// ── Catalog ───────────────────────────────────────────────────────────────────

// Returns the merged catalog: SEED_RULES (builtin:true) + custom rules (builtin:false).
// Each entry: { slug, name, description, body, builtin }.
export async function getCatalog() {
  const custom = await loadCustomRules();
  return [
    ...SEED_RULES,
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

function validateRuleFields({ name, description, body }) {
  if (typeof name !== 'string' || !name.trim()) {
    const err = new Error('rule name is required');
    err.statusCode = 400;
    throw err;
  }
  if (typeof description !== 'string' || !description.trim()) {
    const err = new Error('rule description is required');
    err.statusCode = 400;
    throw err;
  }
  if (typeof body !== 'string' || !body.trim()) {
    const err = new Error('rule body is required');
    err.statusCode = 400;
    throw err;
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function addCustomRule({ slug, name, description, body }) {
  validateSlug(slug);
  validateRuleFields({ name, description, body });
  const catalog = await getCatalog();
  if (catalog.some(r => r.slug === slug)) {
    const err = new Error(`rule slug '${slug}' already exists`);
    err.statusCode = 409;
    throw err;
  }
  const custom = await loadCustomRules();
  custom.push({ slug, name: name.trim(), description: description.trim(), body });
  await saveCustomRules(custom);
  return { slug, name: name.trim(), description: description.trim(), body, builtin: false };
}

export async function updateCustomRule(slug, { name, description, body }) {
  validateSlug(slug);
  if (SEED_RULES.some(r => r.slug === slug)) {
    const err = new Error(`cannot update built-in rule '${slug}'`);
    err.statusCode = 400;
    throw err;
  }
  const custom = await loadCustomRules();
  const idx = custom.findIndex(r => r.slug === slug);
  if (idx === -1) {
    const err = new Error(`rule '${slug}' not found`);
    err.statusCode = 404;
    throw err;
  }
  const updated = {
    ...custom[idx],
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(description !== undefined ? { description: String(description).trim() } : {}),
    ...(body !== undefined ? { body: String(body) } : {}),
  };
  validateRuleFields(updated);
  custom[idx] = updated;
  await saveCustomRules(custom);
  return { ...updated, builtin: false };
}

export async function deleteCustomRule(slug) {
  validateSlug(slug);
  if (SEED_RULES.some(r => r.slug === slug)) {
    const err = new Error(`cannot delete built-in rule '${slug}'`);
    err.statusCode = 400;
    throw err;
  }
  const custom = await loadCustomRules();
  const idx = custom.findIndex(r => r.slug === slug);
  if (idx === -1) {
    const err = new Error(`rule '${slug}' not found`);
    err.statusCode = 404;
    throw err;
  }
  custom.splice(idx, 1);
  await saveCustomRules(custom);
  return { slug };
}

// ── Compose ───────────────────────────────────────────────────────────────────

// Resolves an array of slugs against the catalog and returns the markdown block
// to append after `@../CLAUDE.md\n` in a new project's CLAUDE.md.
// Unknown slugs produce a 400 error. Empty array → '' (no append).
export async function composeRulesBlock(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return '';
  const catalog = await getCatalog();
  const bodies = [];
  for (const slug of slugs) {
    const rule = catalog.find(r => r.slug === slug);
    if (!rule) {
      const err = new Error(`unknown rule slug '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
    bodies.push(rule.body);
  }
  return '\n' + bodies.join('\n\n') + '\n';
}
