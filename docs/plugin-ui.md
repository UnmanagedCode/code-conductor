> See also: [README](../README.md) · [docs/plugins.md](plugins.md) (manifest, proxy, bridge, compliance checklist)

# Building a plugin UI

A plugin owns its architecture, stack and testing. This doc has three layers:

| Layer | Status | What it holds |
|---|---|---|
| [Host contract](#part-1--host-contract-required) | **Required** | What a plugin UI has to do to work inside cc, stated as outcomes, independent of language and stack |
| [Security](#part-2--security-strongly-recommended) | **Strongly recommended** | The threat model and the practices that follow from it |
| [Reference setup](#part-3--optional-the-setup-ccs-own-web-uses) | **Optional** | The React + Vite + Tailwind v4 setup cc's own `web/` uses |

- **cc ships no UI package and no shared kit.** It serves two things to every plugin page: the bridge (`/pluginBridge.js`) and the theme (`/pluginTheme.css`, the palette tokens plus the Geist fonts).
- A plugin may be a Python server, a static site or anything else that serves HTTP.

# Part 1 — Host contract (required)

## Host URLs

Load both in the page's `<head>`:

| URL | Load as | Provides |
|---|---|---|
| `/pluginBridge.js` | Blocking classic script (no `defer`/`async`), first in `<head>` | Theme sync onto `<html>` before first paint; the history contract below; route reporting to cc; optional session awareness (`window.ccBridge`) |
| `/pluginTheme.css` | Stylesheet `<link>` | cc's palette tokens (`:root` and `.dark` custom properties) and the Geist `@font-face` rules |

- These are the only root-relative URLs a plugin page uses (plus the font files the sheet names).
- Standalone (not in a frame, or not under `/plugins/<id>/`) the bridge does nothing, and both URLs answer 404 from the plugin's own server.
- Wire detail: [docs/plugins.md](plugins.md) → Bridge protocol, Theme stylesheet.

## Follow the host theme

- **Follow cc's light/dark live, and read the shared tokens from the sheet.** Embedded, the bridge copies cc's resolved theme onto the page's `<html>`:
  - the `dark` class (present exactly when the theme is dark);
  - `data-cc-theme="light"` or `"dark"` (present only while cc owns the theme).
- It applies this when it runs, before first paint, and again on every change in cc (the sidebar toggle, or an OS flip while cc's theme is "system"), including while the page is hidden.
- **The token names are the custom properties in `web/src/themeTokens.css`**, which the served sheet carries.
- **The served sheet is unlayered.** It wins over anything the page declares inside `@layer`, whatever the source order.
- **No theme toggle of the plugin's own.** A plugin-side toggle stops the page following the host.
- **A restrictive CSP must let the host assets through.** Under `default-src 'none'`, the sheet needs `style-src 'self'`, its Geist fonts (served from `/pluginTheme/fonts/…` on the same origin) need `font-src 'self'`, and the bridge needs `script-src 'self'`. Without `font-src` the fonts are blocked silently and the page falls back to the system font. A policy example: [Part 2](#part-2--security-strongly-recommended).

## Relative URLs

- **Every URL the page requests is relative:** assets, `fetch`, `EventSource`, `WebSocket`.
- **A root-relative `/api/x` reaches cc's API, not the plugin's.** The page's origin is cc's.
- Examples: `fetch('api/board')`, not `fetch('/api/board')`. A socket: `const u = new URL('ws', location.href); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; new WebSocket(u);`
- Redirects the plugin's backend sends may be root-relative (cc rewrites them): [docs/plugins.md](plugins.md) → Plugin-compliance checklist.

## Routing that survives the history contract

- **The bridge turns `history.pushState` into `replaceState`** and reports the route to cc, which mirrors it into its own URL. A plugin visit then adds exactly one joint-history entry, so hardware Back exits to cc.
- **A hash change adds a joint history entry** the bridge cannot turn into a replace, so Back would step through the plugin's states instead of leaving it. Do not navigate by assigning `location.hash`.
- **Keep the document at the plugin root.** The page is served at `/plugins/<id>/` inside cc and at `/` standalone; on a deep path, relative URLs resolve against the wrong directory.
- **Read the route on load and on `popstate`.** cc's `navigate` message arrives as a `popstate`.
- Example scheme: route state in the query string. Write it with `history.pushState(null, '', '?view=card&id=42')`, read it from `location.search`.
- Two examples for the cases that tempt a hash:
  - **An in-page anchor** (`<a href="#section">`): have its click handler call `preventDefault()` and then `scrollIntoView()` on the target, so the click changes no URL.
  - **A legacy hash URL** (an old bookmark such as `#/card/42`): parse it once on load and `history.replaceState` it into the query form, so the document never keeps a hash.
- Multi-page plugins bypass the bridge and pollute history.

## Session awareness (optional)

An **optional host capability, not a contract requirement**: a plugin that ignores it is fully compliant, and it is not part of the contract checks.

- **Detect it.** `window.ccBridge` is absent standalone and on a cc without these messages. Test for it; never assume it.
- **API** (wire detail and result codes: [docs/plugins.md](plugins.md) → Bridge protocol):
  - `ccBridge.session`: `undefined` until cc's first `session` message, then `{sessionId, project, worktree}` or `null`. `worktree` is `null` for the main checkout.
  - `ccBridge.onSession(fn)` → unsubscribe. `fn` runs on every change, and at once if a session message has already arrived.
  - `ccBridge.openSession(sessionId)` → `Promise<{ok, code?}>`: makes a live session the selection. A session that is not live is refused (`SESSION_NOT_LIVE`); cc never resumes one for a plugin.
  - `ccBridge.sendPrompt(sessionId, text)` → `Promise<{ok, code?}>`: behaves exactly like typing into that session's composer (a steer when it is busy, the overage queue, the conductor wake for a conducted worker), without switching to it and without touching the human's draft.
  - A promise never rejects; read `ok` and `code`. cc replies exactly once per call and bounds its own slow reads (10 s), but a page that navigates or reloads mid-call loses the reply, so set your own deadline if you need one.
- **Active session** is cc's one selection (`activeInstance`), whatever the layout:

| Layout | Active session |
|---|---|
| Docked split (desktop) | the session beside the dock |
| Plugin full-screen (`#plugin/<id>/…`) | the session cc returns to when the plugin view closes |
| Phone (below `md`; no split) | same as full-screen |
| Any other full-page view (settings, costs, …) | same: the retained selection |

  - `null` when nothing is selected, or the selected session has no id yet (still spawning).
  - Every plugin frame gets each change, hidden keep-alive frames included.

## Servable after the install hook

What cc runs on Library **Install** and **Update**:

| Step | What runs |
|---|---|
| **Install** (Settings → Plugins → Library) | `git clone`, then the catalog entry's `postClone`, before the plugin's first start |
| **Update** | `git pull --ff-only`, then the entry's `postPull`, then a restart of the plugin's backend if it is running (a stopped one picks the pull up when it next starts) |

- **The hook is the catalog entry's command**, run through `bash -lc`, with cc's own environment, with cwd = the checkout. cc runs nothing else: no `npm install`, no `pip install`, no build.
- **The hook inherits cc's environment**, so a variable set on the cc process (a build-mode or package-manager switch, say) changes what the hook does. A step that depends on one can be skipped or fail under a cc started differently from yours.
- **Whatever builds the UI (and installs the backend's dependencies) happens in that hook**, so the checkout is servable by the time the plugin first starts. Built output is not tracked in git.
- **A drop-in catalog JSON sets the hooks itself** (schema: [docs/plugins.md](plugins.md) → Plugin Library). A built-in entry is the authority for its own command: `DEFAULT_ENTRIES` in `src/plugins/library.ts`.
- **The hook runs code with cc's privileges:** as cc's user with cc's environment. That is the trust the hook itself carries ([docs/plugins.md](plugins.md) → **`postClone`/`postPull` execution**), and it extends to whatever the command runs (lifecycle scripts, dependency install scripts). Add no dependency you would not run as cc.
- A failed hook is a warning, not an error: the clone or pull stays. Update is the retry. A failed `postPull` skips the restart.
- **Start anyway when the UI is not built.** The plugin can still be started after a failed or skipped build, and nothing in cc tells the user the entry file is missing. Have the backend start regardless, log the missing entry file, and answer every UI request with a readable non-HTML 503 that says to build or reinstall. Example: [Serving](#serving-frontenddist-from-the-backend).
- The hook is bounded by `POST_HOOK_TIMEOUT_MS` (`src/plugins/library.ts`).
- Leave nothing in the checkout that an incoming commit can collide with: Update's `git pull --ff-only` aborts when an incoming commit touches a path the hook left modified, or adds a path the hook left untracked. Untrack or ignore anything the hook writes.
- `npm install` plus a `prepare` script is one way to meet this: see [Build on install](#build-on-install) in the reference.

## Standalone legibility

- **The UI is readable when the host URLs 404** (the plugin run outside cc, e.g. `PORT=<port>` on loopback).
- The plugin's server answers `/pluginBridge.js` and `/pluginTheme.css` with a real 404, not with an HTML fallback page.
- Standalone, the page has no host theme to follow. Ship a fallback that keeps it legible (the OS theme, a default palette).

## Contract checks

- [ ] The page loads `/pluginBridge.js` (blocking, first in `<head>`) and `/pluginTheme.css`.
- [ ] Every asset, API and WebSocket URL is relative; no root-relative URL other than the two host URLs.
- [ ] The page follows the sidebar theme toggle live in cc, and the OS theme while cc's theme is "system". It has no toggle of its own.
- [ ] Navigation adds no history entry beyond cc's one: Back from the plugin returns to cc.
- [ ] A fresh `git clone` plus the Library entry's hook, with no other step, leaves a servable checkout; `git status` is clean afterwards.
- [ ] In cc, Settings → Plugins → Library → **Install** reports the `postClone` hook ok; **Update** rebuilds, and restarts the backend if it is running (a stopped one picks the pull up when it next starts).
- [ ] Outside cc the UI is legible; the only console errors concern the two host URLs: their 404, and, when the plugin sends `X-Content-Type-Options: nosniff`, the browser refusing the 404 response as a script or stylesheet because of its MIME type (whatever the body is). Chromium logs the `/pluginTheme.css` refusal twice.

**Trying an unmerged plugin branch in a scratch cc** (leaves your own cc and its plugins alone):

1. In a cc checkout, start an isolated instance: `PORT=<port> scripts/run-isolated.sh` (its own projects root, Claude config dir and port).
2. Adopt the plugin's checkout: `POST /api/projects/external` with `{"name": "<project>", "path": "<absolute path>"}`.
3. `POST /api/plugins/rescan`, then `POST /api/plugins/<id>/enable`. Enable does not start the backend: it starts on first use, or `POST /api/plugins/<id>/start`.
4. Open `http://127.0.0.1:<port>/plugins/<id>/`.
5. Before stopping the scratch cc, `POST /api/plugins/<id>/stop`. Plugin backends run detached and outlive cc, and a restarted cc re-adopts a live one.

# Part 2 — Security (strongly recommended)

These are not enforced by cc. Each is strongly recommended, and the consequence of skipping it is stated.

- **Threat model.** A plugin page is same-origin with cc and runs unsandboxed. cc's API has no authentication on `127.0.0.1`, so a script injected into a plugin page can drive cc: spawn sessions, run commands. It can also prompt any session through `ccBridge.sendPrompt`; that is the same reach as the API, not a widening.
- **Render model- or user-written content as text, never as markup.** Consequence: one unescaped model reply is an injected script with cc's full API.
  - Avoid `innerHTML` / `outerHTML` / `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, and framework raw-HTML escape hatches.
  - Markdown, if you need it: a renderer that builds elements and drops raw HTML, with its links filtered as below.
- **Allowlist link schemes.** Consequence: a `javascript:` or `data:` href built from content runs script on click.
  - The set of schemes is the plugin's choice. Link only schemes you have decided to allow (for external content, typically `http:`, `https:` and `mailto:`) and render anything else as plain text.
  - An external link gets `target="_blank" rel="noopener noreferrer"`. Never put unchecked text into `src`, `href` or `style`.
  - Resolve an external content link with `new URL(u)` and no base. With a base such as `location.href`, `relative/x` and `//evil` both resolve to http(s) links.
- **Send your own CSP, as a minimum.** Consequence: without one, an injected inline script or event handler runs. Start from the policy below and add only what the UI needs. cc's proxy passes the plugin's CSP through unchanged.

```
default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'
```

  - `font-src 'self'` carries the host's Geist fonts; `style-src 'self'` the host sheet; `script-src 'self'` the bridge.
  - Add `style-src 'unsafe-inline'` only when a library you use injects a `<style>` element or sets styles as markup (in the reference setup: Radix Dialog, Sheet, Select and ScrollArea, and sonner).
  - Add `img-src` only if the UI shows images (`'self'`, plus `data:` if it needs inline ones).
  - No inline scripts are allowed under this policy, so a page script lives in a file.
  - **Send it on every response**, the 404, the 503 and error responses included, and send `X-Content-Type-Options: nosniff` with it. Do not serve `.map` files.
  - **Where `'unsafe-inline'` styles are allowed, never emit a `style` attribute or a `<style>` element from content.** Injected CSS is live and can exfiltrate data (attribute selectors with `url()` requests, for one).
  - **What a CSP does not do:**
    - It protects the plugin's own document only. cc's own responses carry no CSP and no framing protection (no `X-Frame-Options`, no `frame-ancestors`).
    - `script-src 'self'` allows every script on cc's origin, which is the plugin page's origin too: every path under `/plugins/<id>/` of every plugin, and cc's own. So it stops an injected inline script or event handler, but it is no containment boundary: an injected `<script src="/…">` naming any script on that origin still runs. Rendering content as text, never markup, is the actual defence.
- **Keep untrusted-content parsing off the thread that answers `healthPath`.** Consequence: a backend that parses content synchronously on that thread can be stalled by a parser that is quadratic or worse, and cc cannot see it.
  - A backend that is already `ready` stays `ready`: cc marks a child dead only when its process is gone, there is no periodic health poll, and the proxy sets no request timeout. Its row keeps saying `ready` while its requests hang.
  - At start it is different: a backend that does not answer within the readiness deadline is recorded as a crash, restarted with backoff, and marked `failed` after repeated crashes. A parser that runs on load (indexing the content before listening, say) lands there.
  - No nested or adjacent quantifiers over untrusted lines.
  - A leading quantifier over characters `.` does not match, followed by `(.*)` and a tail that cannot match, is quadratic on a run of them: `\n`, `\r`, U+2028 and U+2029. Example: `/\s*(.*)x$/` on a string of U+2028 took about 0.5 s at 20,000 characters, 3 s at 40,000 and 13 s at 80,000. Splitting on `\n` first still leaves the other three inside a line.
  - An unanchored `/x+$/` rescans from every start position.
  - Bound nesting depth, and cap the bytes per page.
  - Time your parser at doubling input sizes: a time that grows about fourfold per doubling is quadratic.
- **Bind loopback: `127.0.0.1`, never `0.0.0.0` or `::`.** Consequence: the plugin's API has no authentication, so any interface beyond loopback lets anyone on the network drive it. cc's proxy reaches the backend over loopback.
- **Do not script `window.parent`.** Consequence: it is cc's own page, and the bridge is the supported channel to it.
- **Prefix storage keys** `<plugin-id>:`, and never read or write cc's `code-conductor:*` keys. Consequence: plugins and cc share one origin's storage, so unprefixed keys collide with and corrupt each other's state.

Example link guard (the reference setup's `frontend/src/lib/safeHref.ts`):

```ts
const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

/** `u` as an href when it is an absolute http(s) or mailto URL; null otherwise (render it as text). No base: a relative `u` throws. */
export function safeHref(u: string): string | null {
  try {
    const url = new URL(u);
    return ALLOWED.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
```

```tsx
const href = safeHref(text);
return href ? <a href={href} target="_blank" rel="noopener noreferrer">{text}</a> : <span>{text}</span>;
```

# Part 3 — Optional: the setup cc's own `web/` uses

Follow it to match cc exactly, or don't. Nothing in this part is a requirement; the [host contract](#part-1--host-contract-required) is what a plugin UI has to meet. The stack: React + Vite + Tailwind v4 + shadcn/Radix components + lucide icons + the Geist fonts, built on install, following cc's light/dark theme live. It is written for someone working in the plugin's own repo.

**Reference checks** (for those who follow it) are at the end of this part.

## Sources: a cc checkout first, GitHub as the alternative

Every file this setup takes from cc is named by its path in a code-conductor checkout, written `<cc-checkout>/<path>`. Use a local checkout when you have one: GitHub `main` can lag it. When there is none, the same path is at `https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/<path>`. Each command below shows both.

## Layout

```
conductor.plugin.json
package.json            one package for the backend and the UI
server.js               the backend; serves frontend/dist
.gitignore
frontend/
  index.html  vite.config.ts  tsconfig.json
  public/theme-init.js
  src/
    main.tsx  App.tsx  index.css  cc-theme-fallback.css
    lib/  utils.ts  theme.ts  api.ts  safeHref.ts
    components/ui/      copied from cc, one file per component used
```

- `frontend/` is the directory the existing plugins already use for their UI.
- `frontend/dist/` is built on install ([Build on install](#build-on-install)), and never committed.

## Dependencies

- **`dependencies`: the backend's runtime only** (e.g. `express`).
- **`devDependencies`: everything the UI needs.** It is bundled at build time, so nothing of it is needed at runtime. The list:
  - build: `vite @vitejs/plugin-react @tailwindcss/vite tailwindcss tw-animate-css typescript`
  - UI: `react react-dom @types/react @types/react-dom radix-ui class-variance-authority clsx tailwind-merge lucide-react sonner`
- **Use the ranges cc's own `package.json` declares.** Those builds run on every platform cc runs on, Termux included. This command reads them and installs them as devDependencies, creating `package.json` when the repo has none yet. It adds to an existing `devDependencies` and removes nothing. **Run it in bash** (in another shell, start `bash` first): it splits the specs into a bash array.

```bash
CC_PKG=<cc-checkout>/package.json
# without a checkout:
#   curl -fsSLo cc-package.json https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/package.json && CC_PKG=cc-package.json
SPECS=$(node -e '
  const p = require(require("path").resolve(process.argv[1]));
  const all = { ...p.dependencies, ...p.devDependencies };
  console.log(process.argv.slice(2).map((n) => { if (!all[n]) throw new Error(n + " is not in cc package.json"); return n + "@" + all[n]; }).join(" "));
' "$CC_PKG" vite @vitejs/plugin-react @tailwindcss/vite tailwindcss tw-animate-css typescript \
  react react-dom @types/react @types/react-dom radix-ui class-variance-authority clsx tailwind-merge lucide-react sonner) \
  && read -ra SPEC_LIST <<< "$SPECS" && npm install -D "${SPEC_LIST[@]}"
```

- **Keep what npm writes.** `npm install -D pkg@<range>` records a caret range as `^<installed version>` (cc's `^2.0.0` becomes `^2.1.1`), which stays within cc's major version.
- **Node:** Vite 8 and `@vitejs/plugin-react` declare `engines.node` as `^20.19.0 || >=22.12.0`. Use `>=22.12` as the one floor and record it in `package.json` (`engines.node` below).
- Do **not** add `@fontsource-variable/*`. Embedded, cc serves the fonts; standalone, the font stack falls back to the system font.

## Build on install

**Add these keys to the `package.json` the Dependencies step wrote, and keep its `devDependencies` exactly as installed.** Do not replace the file: without those devDependencies, `prepare` fails with `Cannot find package 'vite'`. `npm pkg set` merges the keys in place:

```sh
# only when the package has no name yet: `npm pkg set name=…` would rename an existing one
[ "$(npm pkg get name)" = '{}' ] && npm pkg set name=my-plugin
npm pkg set type=module engines.node=">=22.12" \
  scripts.start="node server.js" \
  scripts.prepare="vite build --config frontend/vite.config.ts" \
  scripts.dev="vite --config frontend/vite.config.ts" \
  scripts.typecheck="tsc -p frontend"
npm pkg set private=true --json
```

The keys it sets, beside the `devDependencies` (and a backend's `dependencies`) already in the file:

```json
{
  "name": "my-plugin",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "start": "node server.js",
    "prepare": "vite build --config frontend/vite.config.ts",
    "dev": "vite --config frontend/vite.config.ts",
    "typecheck": "tsc -p frontend"
  }
}
```

- `prepare` is what builds the UI: `npm install` with no arguments installs the devDependencies and then runs it.

`.gitignore`:

```
node_modules/
frontend/dist/
package-lock.json
```

- `package-lock.json` stays untracked because `npm install` may rewrite it, and a rewritten tracked lockfile makes Update's `git pull --ff-only` abort whenever an incoming commit touches it.

**Library entries and the hook:**
- cc's built-in Library entries for the UI plugins this setup is for — code-hub, code-kanban, code-karpathy-wiki, code-share, code-system, code-live and code-playbook — run `npm install` in both hooks, so Install builds `frontend/dist` and Update rebuilds it. Other built-in entries run other commands (code-playwright runs `bash install.sh`) or none; `DEFAULT_ENTRIES` in `<cc-checkout>/src/plugins/library.ts` is the authority.
- A drop-in catalog JSON sets `"postClone": "npm install", "postPull": "npm install"`.
- `npm install` runs the repo's own lifecycle scripts (`prepare` included) and its dependencies' install scripts, as cc's user: the hook trust in the contract applies.
- The hook inherits cc's `process.env` (`runHookCommand` in `<cc-checkout>/src/plugins/library.ts`). A cc started with `NODE_ENV=production` or `npm_config_omit=dev` makes `npm install` skip the devDependencies, `vite` is absent, and `prepare` fails, so `npm install` exits non-zero and the Library reports the hook failed. The checkout then has no `frontend/dist`: the backend's 503 ([Serving](#serving-frontenddist-from-the-backend)) is what the user sees.

## `frontend/vite.config.ts`

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// `npm run dev` proxies the API to the backend running standalone (`npm start`).
const backend = process.env.PLUGIN_BACKEND || 'http://127.0.0.1:4000';

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(here, 'src') } },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  server: { proxy: { '/api': { target: backend, ws: true } } },
});
```

- **`base: './'` is what makes this setup meet the relative-URL rule:** the page is served at `/plugins/<id>/` inside cc and at `/` standalone, and relative asset URLs work under both.
- Replace the port with your backend's default port.

`frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

## `frontend/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="/pluginBridge.js" vite-ignore></script>
    <link rel="stylesheet" href="/pluginTheme.css" vite-ignore />
    <script src="theme-init.js" vite-ignore></script>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My plugin</title>
    <script type="module" src="./src/main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

- **Keep that order.** The bridge is a blocking script with no `defer`, first in `<head>`, so cc's theme is on `<html>` before anything paints. `theme-init.js` runs after it and reads what the bridge set.
- **`vite-ignore`** silences Vite 8's build warnings about these three tags (a classic script it cannot bundle, a stylesheet that does not exist at build time). The build copies the tags into `frontend/dist/index.html` unchanged either way, and strips the attribute. Keep it: the build log then shows only real problems.
- Standalone, the two host URLs 404. The backend answers them with a 404, not `index.html`, so it has no SPA fallback ([Serving](#serving-frontenddist-from-the-backend)).

## Theme

**`frontend/src/index.css`:**

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@import './cc-theme-fallback.css';

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: 'Geist Variable', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-info: var(--info);
  --color-plan: var(--plan);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  html,
  body,
  #root {
    height: 100%;
  }
  body {
    @apply bg-background text-foreground antialiased;
  }
}
```

- Keep this `@theme inline` block as written: its `--font-*`, `--radius-*` and `--color-*` entries are the ones in `<cc-checkout>/web/src/index.css`, and cc's `tests/plugin-theme.test.mjs` fails when this doc's block differs from them. cc's own `index.css` also carries mascot animations, which are not part of the comparison and not part of this setup.

**The standalone fallback, `frontend/src/cc-theme-fallback.css`:** a one-time snapshot of cc's tokens wrapped in `@layer base`. Make it from any one of these sources:

```sh
# a cc checkout (no cc running):
{ echo '@layer base {'; cat <cc-checkout>/web/src/themeTokens.css; echo '}'; } > frontend/src/cc-theme-fallback.css
# GitHub:
{ echo '@layer base {'; curl -fsSL https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/web/src/themeTokens.css; echo '}'; } > frontend/src/cc-theme-fallback.css
# a running cc (the tokens follow the `/* cc:tokens */` line):
{ echo '@layer base {'; curl -fsS http://127.0.0.1:8787/pluginTheme.css | sed -n '/^\/\* cc:tokens \*\//,$p'; echo '}'; } > frontend/src/cc-theme-fallback.css
```

- **Never update it to track cc.** Embedded, cc's `/pluginTheme.css` is unlayered, so it wins over anything in `@layer base` whatever the order. The snapshot only shows standalone.

**`frontend/public/theme-init.js`:** standalone, follow the OS.

```js
// Standalone only: follow the OS theme. Embedded in cc, the bridge has already
// set data-cc-theme and owns the dark class.
(function () {
  var root = document.documentElement;
  if (root.hasAttribute('data-cc-theme')) return;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function () { root.classList.toggle('dark', mq.matches); };
  apply();
  mq.addEventListener('change', apply);
})();
```

**`frontend/src/lib/theme.ts`:**

```ts
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** The page's theme; re-renders on every change, embedded or standalone. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current);
}

/** Whether cc's bridge owns the theme (the page is embedded in cc). */
export const isEmbedded = (): boolean => document.documentElement.hasAttribute('data-cc-theme');
```

**Recommended styling practice (cc's own; a design choice, not a contract rule):**
- **Colours in the plugin's own code only through the tokens:** the Tailwind utilities (`bg-card`, `text-muted-foreground`, `border-border`, `text-destructive`, …) or `var(--token)`. Avoid a literal colour there: it does not follow the host theme. The components you copy carry a few of their own (`bg-black/40` on the `dialog.tsx` and `sheet.tsx` overlays, `text-white` on `button.tsx`'s `destructive`); leave those or edit them.
- **Plain CSS:** `background: var(--background); color: var(--foreground); font-family: 'Geist Variable', system-ui, sans-serif;`
- **Canvas or chart code** reads the colour when it draws, and draws again when `useTheme()` changes: `getComputedStyle(document.documentElement).getPropertyValue('--primary')`.

## Components

- **Copy a component when you first use it, never ahead of time.** Copy it from `web/src/components/ui/<name>.tsx` into `frontend/src/components/ui/`:

```sh
mkdir -p frontend/src/components/ui frontend/src/lib
cp <cc-checkout>/web/src/components/ui/button.tsx frontend/src/components/ui/
# GitHub:
curl -fsSLo frontend/src/components/ui/button.tsx https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/web/src/components/ui/button.tsx
```

- **Always copy `web/src/lib/utils.ts`** into `frontend/src/lib/` the same way (`cp <cc-checkout>/web/src/lib/utils.ts frontend/src/lib/`, or `curl -fsSLo frontend/src/lib/utils.ts https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/web/src/lib/utils.ts`). It is `cn()`, every component's class merger.
- **`dialog.tsx` and `sheet.tsx` also need `web/src/lib/modalFocus.ts` and `web/src/lib/textEntry.ts`**, copied into `frontend/src/lib/` the same way.
- A component imports only `react`, `radix-ui`, `class-variance-authority`, `lucide-react` and `@/lib/…`. Check its `import` lines when you copy it.
- **What is available:** the files in `<cc-checkout>/web/src/components/ui/`, which is the authority. Among them: `button`, `input`, `label`, `textarea`, `card`, `badge`, `dialog`, `dropdown-menu`, `select`, `native-select`, `tooltip`, `tabs`, `switch`, `checkbox`, `separator`, `skeleton`, `scroll-area`, `alert`, `popover`, `sheet`.
- **Icons:** lucide's `*Icon` names, e.g. `import { PlusIcon } from 'lucide-react'`. An icon-only button needs an `aria-label`.
- **Toasts:** `sonner`. Render `<Toaster theme={useTheme()} />` once, and call `toast(…)` / `toast.error(…)`. Render it only if the plugin calls `toast`: sonner injects a `<style>` element, which forces `style-src 'unsafe-inline'` in the CSP.
- **A copy is the plugin's code.** Edit it freely; nothing syncs it back.

`frontend/src/main.tsx` (without toasts, drop the `Toaster` import and element and render `<App />` directly):

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { useTheme } from '@/lib/theme';
import { App } from './App';
import './index.css';

function Root() {
  return (
    <>
      <App />
      <Toaster theme={useTheme()} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
```

## What a button variant means

The variants are `button.tsx`'s. This is how cc uses them:

| Variant | Meaning |
|---|---|
| `default` | The one committing action of a form or dialog (Save, Create, Add). `type="submit"`, rightmost in `DialogFooter`, at most one per surface. While it is busy: `disabled`, and `<LoaderCircleIcon className="animate-spin" />` before the label |
| `destructive` | Replaces `default` as the commit when the action deletes or terminates (Delete, Unregister). Never both on one surface. In a menu: `<DropdownMenuItem variant="destructive">`. A loss of data asks first in a confirm dialog |
| `ghost` | Cancel or dismiss, left of the commit, `type="button"` inside a form. Also toolbar and header icon buttons: `size="icon"` or `size="icon-sm"`, with an `aria-label` |
| `outline` | A non-committing alternative beside the commit (Replace), or a secondary action in a toolbar |
| `secondary` | The on state of a toggle button |
| `link` | An inline text action |

- **Every non-submit `Button` inside a `<form>` gets `type="button"`.** A button's default type submits the form.

### What a badge or alert variant means

The variants are `badge.tsx`'s and `alert.tsx`'s. `Badge`:

| Variant | Meaning |
|---|---|
| `outline` | The un-filled chip: a count, tag or label, or a muted negative such as "not installed" |
| `secondary` | A neutral filled label (a source such as "built in", a state such as "installed") |
| `default` | An emphasised label in the primary colour |
| `success`, `warning`, `info`, `plan` | Status chips (translucent fill, matching text) |
| `destructive` | An error or failure status |

`Alert` has `default` (a neutral card), `destructive`, `warning` and `info`; it has no `success` or `plan`.

## API helper

`frontend/src/lib/api.ts`:

```ts
/** A failed request: the HTTP status, and the backend's `{error, code}` body when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/** A JSON request to this plugin's own backend. `path` is relative: a `/`-led path would reach cc's API. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path.startsWith('/')) throw new Error(`api('${path}'): root-relative, so it would reach cc, not this plugin`);
  const res = await fetch(path, init);
  if (!res.ok) {
    const body: { error?: unknown; code?: unknown } | null = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  return (await res.json()) as T;
}
```

- A failure carries `status` and the parsed `{error, code}`, never the raw body: show `error.message`, branch on `status` or `code`.

## Serving `frontend/dist` from the backend

`server.js` (Express):

```js
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'frontend', 'dist');
const indexHtml = path.join(dist, 'index.html');
// The Part 2 minimum. Add `style-src 'unsafe-inline'` only for a library that needs it, `img-src` only for images.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

const app = express();
app.use((_req, res, next) => {
  res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  next();
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.json());
// …the plugin's API routes, under /api…

if (fs.existsSync(indexHtml)) {
  app.use(express.static(dist));
} else {
  console.error(`UI not built: ${indexHtml} is missing — run npm install`);
  app.use((_req, res) => res.status(503).type('text/plain').send('UI not built — run npm install'));
}
// Terminal 404 and error handlers: Express's own pages replace the plugin's CSP with `default-src 'none'`.
app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err);
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).type('text/plain').send(status === 500 ? 'Internal error' : err.message);
});

app.listen(Number(process.env.PORT ?? 4000), '127.0.0.1');
```

- **Loopback only** (see Security): `127.0.0.1`, as above.
- **Order:** the CSP and `nosniff` middleware first, outside the built check, so API responses, the 404 and the 503 carry them too; then the API routes; then `express.static`.
- **No SPA fallback:** an unknown path is a 404, so the host URLs 404 standalone, and routes live in the query string.
- **For a backend that is not Express** (`node:http`, or another language), the same requirements hold:
  - serve the build's `assets/` directory, whose file names carry a base64url hash (letters, digits, `-` and `_`, e.g. `index-D11uSzBd.js`), and serve `index.html` for `/` only;
  - answer every other path with a 404, never `index.html`;
  - set the CSP and `nosniff` on every response, whatever its status;
  - while `index.html` is missing, answer every UI path with a 503 and a plain-text reason, and keep the API and `healthPath` up.
- `$PORT`, `healthPath` and the rest of the backend contract: [docs/plugins.md](plugins.md) → Plugin-compliance checklist (`<cc-checkout>/docs/plugins.md`, or `https://github.com/UnmanagedCode/code-conductor/blob/main/docs/plugins.md`).

## Reference checks

For a plugin that follows this setup, beside the contract checks:

- [ ] `npm install` → `frontend/dist/index.html` exists.
- [ ] With `frontend/dist` removed, `npm start` still starts, logs the missing entry file, and answers `/` with a 503 that is not HTML.
- [ ] Every response carries the CSP, the 404 and the 503 included.
- [ ] The built CSS has no absolute URL: `perl -0pe 's{/\*.*?\*/}{}gs' frontend/dist/assets/*.css | grep -nE 'https?://|url\(//'` prints nothing. The `perl` strips the `/* */` comments first, because Tailwind's header comment contains `https://tailwindcss.com`.
- [ ] `PORT=<port> npm start` → `http://127.0.0.1:<port>/` loads.
- [ ] The backend listens on `127.0.0.1` only: `http://<this machine's LAN address>:<port>/` does not answer.
- [ ] Legible with the OS in light and in dark (DevTools → Rendering → Emulate CSS `prefers-color-scheme`), and it follows a flip live.
- [ ] `npm run dev` serves the UI with the API proxied to the backend.
- [ ] `git clone` → `npm install`, with no other step → `frontend/dist` is built, and `git status` is clean afterwards.
- [ ] The Library entry's hooks are `npm install` for `postClone` and `postPull`.
