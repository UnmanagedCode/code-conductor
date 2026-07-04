// Migration 0008: rewrite old flat per-session entries in
// `session-summaries.json` into the current tiered shape.
//
// Before: { summaries: { "<sid>": { summary, length, generatedAt, messageCount } } }
// After:  { summaries: { "<sid>": { [length]: { summary, generatedAt, messageCount } } } }
//
// Mirrors normalizeEntry/normalizeTierRecord in src/sessionSummaries.js as
// they stood before that module's old-shape tolerance was removed: an
// invalid length or empty summary means the entry is dropped entirely,
// exactly as the read-time normalizer used to drop it from the returned map.
//
// Scope: a single file in the central store, `<root>/.code-conductor/session-summaries.json`.
// Idempotent: a no-op once no entry is in the old flat shape.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0008-migrate-tiered-session-summaries';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

const VALID_LENGTHS = new Set(['short', 'medium', 'long']);

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

// Mirrors normalizeTierRecord: valid iff summary is a non-empty string.
function tierRecordFromOldShape(raw) {
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) return null;
  return {
    summary: raw.summary.trim(),
    generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : 0,
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
  };
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const file = path.join(projectsRoot, '.code-conductor', 'session-summaries.json');

  const parsed = await readJsonSafe(file);
  if (!parsed || typeof parsed !== 'object' || !parsed.summaries || typeof parsed.summaries !== 'object') {
    return { applied: false };
  }

  const oldShapeSids = Object.entries(parsed.summaries)
    .filter(([, raw]) => raw && typeof raw === 'object'
      && typeof raw.summary === 'string' && typeof raw.length === 'string')
    .map(([sid]) => sid);
  if (oldShapeSids.length === 0) return { applied: false };

  let entriesMigrated = 0;
  let entriesDropped = 0;
  for (const sid of oldShapeSids) {
    const raw = parsed.summaries[sid];
    const len = raw.length;
    const rec = VALID_LENGTHS.has(len) ? tierRecordFromOldShape(raw) : null;
    if (rec) {
      parsed.summaries[sid] = { [len]: rec };
      entriesMigrated++;
    } else {
      delete parsed.summaries[sid];
      entriesDropped++;
    }
  }

  await writeJsonAtomic(file, parsed);
  log(`  ✓ migrated ${entriesMigrated} session-summary entr${entriesMigrated === 1 ? 'y' : 'ies'} to tiered shape in ${file}${entriesDropped ? ` (dropped ${entriesDropped} invalid)` : ''}`);
  return { applied: true, summary: { entriesMigrated, entriesDropped } };
}
