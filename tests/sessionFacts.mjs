// Test-side views of the unified session store (src/sessionStore.ts): the sets
// of transcript ids carrying a segment flag, read through the store or straight
// off a `sessions.json` document.

import { loadSessions } from '../src/sessionStore.ts';

// Live segment ids with `flag` set, from a parsed `sessions.json` document.
export function flaggedIdsIn(doc, flag) {
  const out = new Set();
  for (const rec of Object.values(doc?.sessions ?? {})) {
    for (const s of rec.segments ?? []) if (s[flag] === true && s.dropped !== true) out.add(s.id);
  }
  return out;
}

async function flagged(flag) {
  const out = new Set();
  for (const rec of (await loadSessions()).byPublic.values()) {
    for (const s of rec.segments) if (s[flag] && !s.dropped) out.add(s.id);
  }
  return out;
}

export const archivedIds = () => flagged('archived');
export const tempIds = () => flagged('temp');
