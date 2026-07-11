// Project convention modules — a catalog of named CLAUDE.md sections that can be
// appended inline to a new project's CLAUDE.md at creation time.
//
// Seeds are read-only (builtin: true); their bodies live in committed `.md`
// fragments under project-conventions/<slug>.md. Custom conventions
// (builtin: false) are persisted at <orchStoreRoot>/project-conventions.json.
// Both the catalog and the compose/CRUD logic are provided by the shared
// fragment-catalog helper, which is also used by the conductor convention
// modules (src/conductModules.js) and the workspace convention modules
// (src/workspaceModules.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.js';
import { createFragmentCatalog } from './fragmentCatalog.js';

const CONVENTIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'project-conventions');

// Seed metadata (bodies in project-conventions/<slug>.md).
export const SEED_PROJECT_CONVENTIONS = [
  { slug: 'design-guidelines', name: 'Design guidelines',
    description: 'YAGNI; no god-modules; single source of truth; thin bootstrap; shared service layer' },
  { slug: 'testing-guidelines', name: 'Testing guidelines',
    description: 'Prefer automated tests over manual checklists; deterministic; isolated; fake external deps' },
  { slug: 'documentation-guidelines', name: 'Documentation guidelines',
    description: 'Layered docs (README + docs/features/protocol/architecture); update the most-specific file when behavior changes' },
  { slug: 'migration-guidelines', name: 'Migration guidelines',
    description: 'One-shot startup migrations, not read-time compat shims; no legacy aliases or dual-shape parsing; unstable APIs owe no back-compat' },
];

// Plugin-contributed convention fragments join the catalog through this
// provider. It is injected after construction (server.js wires it to the
// plugin host) because the host is a runtime singleton, not importable here
// without a cycle. Default is a no-op so tests/imports without plugins work.
let pluginConventionsProvider = async () => [];
export function setPluginConventionsProvider(fn) { pluginConventionsProvider = fn ?? (async () => []); }

const catalog = createFragmentCatalog({
  seeds: SEED_PROJECT_CONVENTIONS,
  seedDir: CONVENTIONS_DIR,
  storeFile: () => path.join(orchStoreRoot(), 'project-conventions.json'),
  noun: 'convention',
  extraProvider: () => pluginConventionsProvider(),
});

// Merged catalog: SEED_PROJECT_CONVENTIONS (builtin:true) + custom conventions (builtin:false).
// Each entry: { slug, name, description, body, builtin }.
export const getCatalog = catalog.getCatalog;
export const validateSlug = catalog.validateSlug;
export const addCustomConvention = catalog.addCustom;
export const updateCustomConvention = catalog.updateCustom;
export const deleteCustomConvention = catalog.deleteCustom;

// Resolves an array of slugs against the catalog and returns the markdown block
// to append after `@../CLAUDE.md\n` in a new project's CLAUDE.md. Unknown slugs
// produce a 400 error. Slugs whose convention carries only a scaffold facet (no
// fragment body) contribute nothing. Empty array → '' (no append).
export const composeProjectConventionsBlock = catalog.compose;

// Resolves selected slugs against the catalog and composes the one-time setup
// directives of those that carry a scaffold facet into a single orchestrator-
// guidance block that `create_project` RETURNS (never persisted), for the
// conductor to fold into its first worker brief. Slugs are resolved in
// selection order; unknown slug → 400; a slug without a scaffold facet is
// skipped. No scaffold facets among the selection → '' (no scaffold).
export async function composeProjectScaffold(projectName, slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return '';
  const entries = await getCatalog();
  const bySlug = new Map(entries.map(e => [e.slug, e]));
  const steps = [];
  for (const slug of slugs) {
    const entry = bySlug.get(slug);
    if (!entry) {
      const err = new Error(`unknown convention slug '${slug}'`);
      err.statusCode = 400;
      throw err;
    }
    if (entry.scaffold) steps.push(entry.scaffold);
  }
  if (steps.length === 0) return '';
  const numbered = steps.map((t, i) => `${i + 1}) ${t}`).join('\n\n');
  return `Project "${projectName}" was created with these scaffolding steps. Complete them first, before other work:\n\n${numbered}`;
}
