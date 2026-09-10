// Migration 0033: the convention SELECTION stores no longer persist an
// `enabled` ALLOW-list. They persist a `disabled` DENY-list, so a slug added to
// SEED_CONVENTIONS reaches every install with no migration (card 2026-0123 —
// the bug class 0015 and 0029 each patched by hand).
//
// Two scopes, `<root>/.code-conductor/conventions/{workspace,conductor}.json`,
// as two INDEPENDENT steps so an early return can never skip the second.
//
// Before: { enabled: ['git-hygiene', …], pluginOff: ['acme/x'], rules: [ … ] }
// After:  { disabled: ['acme/x'], rules: [ … ] }
//
// A BREAKING RESET, not a preserving conversion. The old `enabled` array is
// DISCARDED and nothing is computed from it: a deny-list derived from it would
// need a snapshot of the seed set at this point in history, which is the very
// trap being retired. Consequence (accepted, same trade as 0021's note): a
// convention the user had UNTICKED comes back ON at the next boot. The
// discarded arrays are returned in `summary`, so the one boot line
// `migration 0033-…: applied — {…}` names them once rather than losing them
// silently.
//
// `pluginOff` is CARRIED OVER into `disabled` verbatim — it is already the
// right polarity, so that is a rename, not a conversion, and it needs no
// snapshot. Dropping it would silently re-enable plugin conventions the user
// unchecked, which is a second, unrelated breaking change.
//
// Idempotent by structure: once neither `enabled` nor `pluginOff` exists on
// either file, there is nothing to do and the run reports `{applied:false}`.
// Probe: `grep -l '"enabled"' <root>/.code-conductor/conventions/*.json`.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0033-drop-convention-enabled-allow-list';

const SCOPES = ['workspace', 'conductor'];

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
  const summary = {};

  for (const scope of SCOPES) {
    const file = path.join(projectsRoot, '.code-conductor', 'conventions', `${scope}.json`);
    const store = await readJsonSafe(file);
    if (!store || typeof store !== 'object') continue;
    if (!('enabled' in store) && !('pluginOff' in store)) continue;

    const discarded = Array.isArray(store.enabled) ? store.enabled : [];
    const carried = Array.isArray(store.pluginOff) ? store.pluginOff : [];
    const disabled = [...new Set([
      ...(Array.isArray(store.disabled) ? store.disabled : []),
      ...carried,
    ])];

    delete store.enabled;
    delete store.pluginOff;
    if (disabled.length > 0) store.disabled = disabled;

    await writeJsonAtomic(file, store);
    log(`  ✓ ${scope}: dropped the \`enabled\` allow-list (${discarded.length} slug(s) discarded, `
      + `${carried.length} off-switch(es) carried over) in ${file}`);
    summary[scope] = { discardedEnabled: discarded, carriedPluginOff: carried };
  }

  if (Object.keys(summary).length === 0) return { applied: false };
  return { applied: true, summary };
}
