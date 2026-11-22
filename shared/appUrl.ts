// The app's own URLs under a hosting prefix (CC_BASE_PATH, docs/protocol/rest-settings.md).
//
// The build is prefix-agnostic: routing is hash-only and every history write
// keeps `location.pathname`, so the page's directory (`document.baseURI`
// resolved against './') IS the app base. Every client URL for a server path
// ('/api/…', '/ws', '/plugins/…', '/sw.js') goes through appUrl, which at root
// returns its input unchanged.

/** `path` ('/'-led app path, optionally with ?query#hash) resolved under the app base of `baseURI`; returns pathname + search + hash. Throws on a path that is not '/'-led or is '//'-led. */
export function appUrlFrom(baseURI: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`appUrl: not an app path: ${JSON.stringify(path)}`);
  const u = new URL(path.slice(1), new URL('./', baseURI));
  return u.pathname + u.search + u.hash;
}

/** `appUrlFrom` against the live document; the identity where there is no http(s) document (node tests, server imports). */
export function appUrl(path: string): string {
  if (typeof document === 'undefined' || !/^https?:/.test(document.baseURI)) return path;
  return appUrlFrom(document.baseURI, path);
}
