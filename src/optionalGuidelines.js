// Optional guideline modules — a catalog of named CLAUDE.md sections that can be
// appended inline to a new project's CLAUDE.md at creation time.
//
// Seeds are read-only (builtin: true); their bodies live in committed `.md`
// fragments under guidelines/<slug>.md. Custom guidelines (builtin: false) are
// persisted at <orchStoreRoot>/optional-guidelines.json. Both the catalog and
// the compose/CRUD logic are provided by the shared fragment-catalog helper,
// which is also used by the conductor convention modules (src/conductModules.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.js';
import { createFragmentCatalog } from './fragmentCatalog.js';

const GUIDELINES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'guidelines');

// Seed metadata (bodies in guidelines/<slug>.md).
export const SEED_GUIDELINES = [
  { slug: 'design-guidelines', name: 'Design guidelines',
    description: 'YAGNI; no god-modules; single source of truth; thin bootstrap; shared service layer' },
  { slug: 'testing-guidelines', name: 'Testing guidelines',
    description: 'Prefer automated tests over manual checklists; deterministic; isolated; fake external deps' },
  { slug: 'documentation-guidelines', name: 'Documentation guidelines',
    description: 'Layered docs (README + docs/features/protocol/architecture); update the most-specific file when behavior changes' },
  { slug: 'migrations-over-compat', name: 'Migration guidelines',
    description: 'One-shot startup migrations, not read-time compat shims; no legacy aliases or dual-shape parsing; unstable APIs owe no back-compat' },
];

const catalog = createFragmentCatalog({
  seeds: SEED_GUIDELINES,
  seedDir: GUIDELINES_DIR,
  storeFile: () => path.join(orchStoreRoot(), 'optional-guidelines.json'),
  noun: 'guideline',
});

// Merged catalog: SEED_GUIDELINES (builtin:true) + custom guidelines (builtin:false).
// Each entry: { slug, name, description, body, builtin }.
export const getCatalog = catalog.getCatalog;
export const validateSlug = catalog.validateSlug;
export const addCustomGuideline = catalog.addCustom;
export const updateCustomGuideline = catalog.updateCustom;
export const deleteCustomGuideline = catalog.deleteCustom;

// Resolves an array of slugs against the catalog and returns the markdown block
// to append after `@../CLAUDE.md\n` in a new project's CLAUDE.md. Unknown slugs
// produce a 400 error. Empty array → '' (no append).
export const composeGuidelinesBlock = catalog.compose;
