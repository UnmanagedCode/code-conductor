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
export const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}
