// Migration 0028: convert the persisted `defaultPlaybook` selection to its
// tri-state shape.
//
// The selection used to be `<id> | null`, where null and an absent key were the
// same thing: nothing injected. It is now three states, because never having
// chosen is not the same as having chosen nothing — unset resolves to the
// built-in default playbook, while an explicit `{"mode":"none"}` still injects
// nothing (see DefaultPlaybookSelection in src/conductorConventions.ts).
//
//   key absent  → left alone            (already unset)
//   null        → key DELETED           (unset, so it picks up the built-in default)
//   "<id>"      → {"mode":"playbook","id":"<id>"}
//
// A pre-change store maps to UNSET, never to the explicit opt-out: nobody who
// predates this change ever chose "none", so reading their null as a deliberate
// opt-out would silently deny them the new default. That includes a store 0027
// cleared to null (its `research` case) — landing on the default is the intent.
//
// The id is preserved inside the new object; nothing is destroyed.
//
// Idempotent: a no-op once the value is a tagged object or the key is absent.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0028-tri-state-default-playbook';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const file = path.join(projectsRoot, '.code-conductor', 'conventions', 'conductor.json');

  const store = await readJsonSafe(file);
  if (!store || typeof store !== 'object') return { applied: false };

  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an absent key
  // named like an Object.prototype member would be "migrated" into existence.
  if (!Object.hasOwn(store, 'defaultPlaybook')) return { applied: false };

  const from = store.defaultPlaybook;
  let to;
  if (from === null) {
    delete store.defaultPlaybook;
    to = 'unset';
  } else if (typeof from === 'string' && from) {
    store.defaultPlaybook = { mode: 'playbook', id: from };
    to = `{mode:'playbook',id:'${from}'}`;
  } else {
    // Already tagged (or a shape this migration has no claim on) — leave it.
    return { applied: false };
  }

  await writeJsonAtomic(file, store);
  log(`  ✓ defaultPlaybook ${JSON.stringify(from)} → ${to} in ${file}`);
  return { applied: true, summary: { from, to } };
}
