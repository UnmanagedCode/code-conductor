// Identifier shapes shared across the tree.
//
// These were previously re-declared per module with three different enforcement
// styles (throw a 400, push onto an `errors[]`, return null), and the rules had
// to be kept in sync by hand. The RULE lives here; the REFUSAL stays at the call
// site, because each surface refuses differently on purpose:
//   - fragmentCatalog / appSettings throw a 400 (REST mutation endpoints)
//   - plugins/manifest accumulates into `errors[]` (a manifest reports every
//     problem at once, then the plugin is marked invalid)
//   - routes throws a 400, projects returns null (a lookup, not a mutation)

// Lowercase kebab identifier: a convention/rule slug, a plugin id, a plugin
// convention/role slug, a backend registry id. Deliberately NOT the custom-role
// name rule (`^[A-Za-z][A-Za-z0-9-]*$`, appSettings) — a custom role name is a
// case-preserving user label, this is a lowercase machine identifier.
export const SLUG_RE = /^[a-z][a-z0-9-]*$/;
export const SLUG_MAX = 40;

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value) && value.length <= SLUG_MAX;
}

// Session ids reach the server as user-supplied path params and are used to
// build filesystem paths (`<encoded-cwd>/<sid>.jsonl`), so this allow-list is
// the path-traversal guard, not merely a format check: no `.`, `/` or `\`.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

// The two forms mintPublicId (src/sessionLineage.ts) produces: 8 hex chars, or
// its `xxxxxxxx-xxxx` extension. A full UUID, a base-case id and every existing
// fixture are all longer, so they pass this test.
const MINTED_PUBLIC_ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4})?$/;

// True when `id` has one of the shapes mintPublicId produces — i.e. it can only
// ever be a PUBLIC id, so it can never name a transcript file. A caller that has
// already resolved through resolveBacking() and STILL sees this shape is holding
// an id no session on disk answers to: that is an UNKNOWN SESSION, not an error,
// and it must degrade to that caller's normal miss path (null / false / 404)
// rather than trip assertBackingId and surface as a 500.
export function isMintedPublicId(id: unknown): boolean {
  return typeof id === 'string' && MINTED_PUBLIC_ID_RE.test(id);
}

// Loud runtime guard on the public/backing boundary. A session's PUBLIC id is
// neither a filename nor a `--resume` argument — those need its CURRENT backing
// id, obtained from `resolveBacking()` (src/sessionLineage.ts) or read off
// `Instance.backingSessionId`. This throws, with the call site named, when it is
// handed something that looks exactly like one of our minted public ids.
//
// It is an ASSERTION, not a behavioural branch: nothing RESOLVES differently by
// id length. If a fixture ever collides with the pattern, rename the fixture —
// do not weaken the guard.
export function assertBackingId(id: string, where: string): void {
  if (typeof id === 'string' && MINTED_PUBLIC_ID_RE.test(id)) {
    throw new Error(
      `${where}: '${id}' is a public session id, not a backing id — resolve it through `
      + 'resolveBacking() (src/sessionLineage.ts) or read Instance.backingSessionId',
    );
  }
}
