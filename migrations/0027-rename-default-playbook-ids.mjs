// Migration 0027: remap the persisted `defaultPlaybook` selection onto the
// renamed built-in playbook ids.
//
// The built-in set was cut from four to three and renamed: classic → solo,
// split → relay, research → deleted (its read-only fan-out is now freeform's,
// which no longer forbids a worktree). The ids themselves needed no migration —
// nothing persists them but the ledger, which is reset — but the SELECTED
// DEFAULT is a user setting living in the conductor conventions store as the
// `defaultPlaybook` sibling key.
//
// Without this, an existing selection stops resolving and
// defaultPlaybookConvention() silently omits the whole default-playbook section
// from the conductor's system prompt: a console.warn server-side and no visible
// signal anywhere else. That silence is the reason this migration exists.
//
// `research` maps to null (cleared), not to a substitute: freeform covers the
// use, but choosing a default for the user is not this migration's business.
//
// Idempotent: a no-op once the value is a current id, absent, null, or any
// user-overlay id it does not recognise.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0027-rename-default-playbook-ids';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Old id -> new id, or null to clear the selection.
const REMAP = { classic: 'solo', split: 'relay', research: null };

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

  const from = store.defaultPlaybook;
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so a selection of
  // "toString" would pass the guard, be assigned a function, and vanish when
  // JSON.stringify drops it — silently clearing a value this migration promises
  // to leave alone.
  if (typeof from !== 'string' || !Object.hasOwn(REMAP, from)) return { applied: false };

  const to = REMAP[from];
  store.defaultPlaybook = to;
  await writeJsonAtomic(file, store);
  log(`  ✓ defaultPlaybook '${from}' → ${to === null ? 'null (cleared)' : `'${to}'`} in ${file}`);
  return { applied: true, summary: { from, to } };
}
