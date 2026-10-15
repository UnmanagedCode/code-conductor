> See also: [README](../README.md) · [docs/plugins.md](plugins.md) (manifest, proxy, bridge, compliance checklist)

# Building a plugin UI

The recipe for a plugin frontend that looks and behaves like cc's own UI: React + Vite + Tailwind v4 + shadcn/Radix components + lucide icons + the Geist fonts, built on install, following cc's light/dark theme live. It is written for someone working in the plugin's own repo.

- **cc ships no UI package and no shared kit.** It serves two things to every plugin page: the bridge (`/pluginBridge.js`) and the theme (`/pluginTheme.css`, the palette tokens plus the Geist fonts). A plugin copies the components it uses into its own repo, and owns them from then on.
- **Standalone, the same build still runs.** Outside cc, both host URLs 404, which is harmless. The page then follows the OS theme from a bundled snapshot of the tokens.

## Sources: a cc checkout first, GitHub as the alternative

Every file this recipe takes from cc is named by its path in a code-conductor checkout, written `<cc-checkout>/<path>`. Use a local checkout when you have one: GitHub `main` can lag it. When there is none, the same path is at `https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/<path>`. Each command below shows both.

## 1. Layout

```
conductor.plugin.json
package.json            one package for the backend and the UI
server.js               the backend; serves frontend/dist
.gitignore
frontend/
  index.html  vite.config.ts  vitest.config.ts  tsconfig.json
  public/theme-init.js
  src/
    main.tsx  App.tsx  index.css  cc-theme-fallback.css
    lib/  utils.ts  theme.ts  api.ts  safeHref.ts
    components/ui/      copied from cc, one file per component used
    test/setup.ts
```

- `frontend/` is the directory the existing plugins already use for their UI.
- `frontend/dist/` is built on install (§3), and never committed.

## 2. Dependencies

- **`dependencies`: the backend's runtime only** (e.g. `express`).
- **`devDependencies`: everything the UI needs.** It is bundled at build time, so nothing of it is needed at runtime. The list:
  - build: `vite @vitejs/plugin-react @tailwindcss/vite tailwindcss tw-animate-css typescript`
  - UI: `react react-dom @types/react @types/react-dom radix-ui class-variance-authority clsx tailwind-merge lucide-react sonner`
  - tests: `vitest happy-dom @testing-library/react @testing-library/user-event`
- **Use the ranges cc's own `package.json` declares.** Those builds run on every platform cc runs on, Termux included. This command reads them and installs them as devDependencies, creating `package.json` when the repo has none yet. **Run it in bash** (in another shell, start `bash` first): it splits the specs into a bash array.

```bash
CC_PKG=<cc-checkout>/package.json
# without a checkout:
#   curl -fsSLo cc-package.json https://raw.githubusercontent.com/UnmanagedCode/code-conductor/main/package.json && CC_PKG=cc-package.json
SPECS=$(node -e '
  const p = require(require("path").resolve(process.argv[1]));
  const all = { ...p.dependencies, ...p.devDependencies };
  console.log(process.argv.slice(2).map((n) => { if (!all[n]) throw new Error(n + " is not in cc package.json"); return n + "@" + all[n]; }).join(" "));
' "$CC_PKG" vite @vitejs/plugin-react @tailwindcss/vite tailwindcss tw-animate-css typescript \
  react react-dom @types/react @types/react-dom radix-ui class-variance-authority clsx tailwind-merge lucide-react sonner \
  vitest happy-dom @testing-library/react @testing-library/user-event) \
  && read -ra SPEC_LIST <<< "$SPECS" && npm install -D "${SPEC_LIST[@]}"
```

- Do **not** add `@fontsource-variable/*`. Embedded, cc serves the fonts; standalone, the font stack falls back to the system font.

## 3. Build on install

**Add these keys to the `package.json` §2 wrote, and keep its `devDependencies` exactly as §2 installed them.** Do not replace the file: without those devDependencies, `prepare` fails with `Cannot find package 'vite'`. `npm pkg set` merges the keys in place:

```sh
npm pkg set name=my-plugin type=module \
  scripts.start="node server.js" \
  scripts.prepare="vite build --config frontend/vite.config.ts" \
  scripts.dev="vite --config frontend/vite.config.ts" \
  scripts.typecheck="tsc -p frontend" \
  scripts.test:web="vitest run --config frontend/vitest.config.ts" \
  scripts.test="npm run typecheck && npm run test:web"
npm pkg set private=true --json
```

The keys it sets, beside the `devDependencies` (and a backend's `dependencies`) already in the file:

```json
{
  "name": "my-plugin",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "prepare": "vite build --config frontend/vite.config.ts",
    "dev": "vite --config frontend/vite.config.ts",
    "typecheck": "tsc -p frontend",
    "test:web": "vitest run --config frontend/vitest.config.ts",
    "test": "npm run typecheck && npm run test:web"
  }
}
```

- `prepare` is what builds the UI: `npm install` with no arguments installs the devDependencies and then runs it.
- A backend test command goes in front of `test:web` in `test` (e.g. `node --test && npm run test:web`).

`.gitignore`:

```
node_modules/
frontend/dist/
package-lock.json
```

- `package-lock.json` stays untracked because `npm install` may rewrite it, and that leaves the checkout dirty. Update's `git pull --ff-only` refuses to run over the dirt.

**How cc installs the plugin:**

| Step | What runs |
|---|---|
| **Install** (Settings → Plugins → Library) | `git clone`, then the catalog entry's `postClone`, before the plugin's first start |
| **Update** | `git pull --ff-only`, then the entry's `postPull`, then the plugin's auto-restart |

- Both hooks run through `bash -lc`, with cc's own environment, with cwd = the checkout.
- cc's built-in Library entries for the UI plugins this recipe is for — code-hub, code-kanban, code-karpathy-wiki, code-share, code-system, code-live and code-playbook — run `npm install` in both hooks, so Install builds `frontend/dist` and Update rebuilds it. Other built-in entries run other commands (code-playwright runs `bash install.sh`) or none; `DEFAULT_ENTRIES` in `<cc-checkout>/src/plugins/library.ts` is the authority.
- **`npm install` runs code with cc's privileges:** on Install and Update it runs the repo's own lifecycle scripts (`prepare` included) and its dependencies' install scripts, as cc's user with cc's environment. That is the same trust the hook itself carries ([docs/plugins.md](plugins.md) → **`postClone`/`postPull` execution**), so add no dependency you would not run as cc.
- **A drop-in catalog JSON must set the hooks itself:** `"postClone": "npm install", "postPull": "npm install"` (schema: [docs/plugins.md](plugins.md) → Plugin Library).
- A failed hook is a warning, not an error: the clone or pull stays. Update is the retry. A failed `postPull` skips the restart.
- The hook is bounded by `POST_HOOK_TIMEOUT_MS` (`<cc-checkout>/src/plugins/library.ts`).
- An environment with `NODE_ENV=production` (or `npm_config_omit=dev`) makes `npm install` skip the devDependencies, and the build then fails.

## 4. `frontend/vite.config.ts`

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

- **`base: './'` is required.** The page is served at `/plugins/<id>/` inside cc and at `/` standalone. Relative asset URLs work under both.
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

## 5. URLs: relative, never `/`-led

- **Every URL the page requests is relative:** assets, `fetch`, `EventSource`, `WebSocket`.
  - `fetch('api/board')`, not `fetch('/api/board')`.
  - A socket: `const u = new URL('ws', location.href); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; new WebSocket(u);`
- **A root-relative `/api/x` reaches cc's API, not the plugin's.** The page's origin is cc's.
- **The only root-relative URLs are the host-served `/pluginBridge.js` and `/pluginTheme.css`** (and the font files the sheet names).
- **Routing:** keep the document at the plugin root, and put route state in the query string.
  - Write it with `history.pushState(null, '', '?view=card&id=42')`. The bridge turns that into a `replaceState` and reports the route to cc, which mirrors it into its own URL.
  - Read it from `location.search`, on load and on `popstate`. cc's `navigate` arrives as a `popstate`.
  - **No path routes.** On a deep path, the relative URLs and `base: './'` resolve against the wrong directory.
  - **Never assign `location.hash`.** It adds a joint history entry that the bridge cannot turn into a replace.

## 6. `frontend/index.html`

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
- Standalone, `/pluginBridge.js` and `/pluginTheme.css` 404, which is harmless. The backend must answer them with a 404, not with `index.html`, so it has no SPA fallback (§11).

## 7. Theme

**What the bridge does to the page:**
- Standalone (not in a frame, or not under `/plugins/<id>/`) it does nothing.
- Embedded, it copies cc's resolved theme onto the page's `<html>`: the `dark` class, and `data-cc-theme="light"` or `"dark"`. It does this when it runs, before first paint, and again on every change in cc (the sidebar toggle, or an OS flip while cc's theme is "system"), including while the page is hidden.
- It also turns `pushState` into `replaceState` and reports routes (§5).

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

- The `@theme inline` block is cc's own (`<cc-checkout>/web/src/index.css`), without its mascot animations. cc's `tests/plugin-theme.test.mjs` fails when the two differ.

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

**Rules:**
- **No theme toggle of the plugin's own.** cc's choice applies.
- **Colours only through the tokens:** the Tailwind utilities (`bg-card`, `text-muted-foreground`, `border-border`, `text-destructive`, …) or `var(--token)`. Never a literal colour.
- **Plain CSS:** `background: var(--background); color: var(--foreground); font-family: 'Geist Variable', system-ui, sans-serif;`
- **Canvas or chart code** reads the colour when it draws, and draws again when `useTheme()` changes: `getComputedStyle(document.documentElement).getPropertyValue('--primary')`.
- The token names are the custom properties in `<cc-checkout>/web/src/themeTokens.css`.

## 8. Components

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
- **Toasts:** `sonner`. Render `<Toaster theme={useTheme()} />` once, and call `toast(…)` / `toast.error(…)`.
- **A copy is the plugin's code.** Edit it freely; nothing syncs it back.

`frontend/src/main.tsx`:

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

## 9. What a button variant means

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

## 10. Security

- **A plugin page is same-origin with cc and runs unsandboxed.** cc's API has no authentication on `127.0.0.1`, so a script injected into a plugin page can drive cc: spawn sessions, run commands.
- **Render model- or user-written content as React text children only.** Never `dangerouslySetInnerHTML`, `innerHTML` / `outerHTML` / `insertAdjacentHTML`, `document.write`, `eval` or `new Function`.
- **Markdown**, if you need it: only a renderer that builds React elements and drops raw HTML (`react-markdown` without `rehype-raw`), with its links through `safeHref`.
- **Links:** an `href` built from content goes through `safeHref`, and anything it refuses renders as plain text. An external link gets `target="_blank" rel="noopener noreferrer"`. Never put unchecked text into `src`, `href` or `style`.

`frontend/src/lib/safeHref.ts`:

```ts
const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

/** `u` as an href when it parses to an http(s) or mailto URL; null otherwise (render it as text). */
export function safeHref(u: string): string | null {
  try {
    const url = new URL(u, location.href);
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

- **`localStorage`:** prefix your own keys `<plugin-id>:`. Never read or write cc's `code-conductor:*` keys.
- **Never script `window.parent`.** The bridge is the only channel to cc.
- **The backend sends its own CSP** on its responses. cc's proxy passes it through unchanged:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'
```

- `style-src 'unsafe-inline'` is there because Radix and sonner inject `<style>` elements.
- No inline scripts are allowed, which is why `theme-init.js` is a file.
- **What this CSP does not do:**
  - It protects the plugin's own document only. cc's own responses carry no CSP and no framing protection (no `X-Frame-Options`, no `frame-ancestors`).
  - `script-src 'self'` allows every script on cc's origin, which is the plugin page's origin too: every path under `/plugins/<id>/` of every plugin, and cc's own. So it stops an injected inline script or event handler, but it is no containment boundary: an injected `<script src="/…">` naming any script on that origin still runs. The rules above about never rendering content as markup are the actual defence.

`frontend/src/lib/api.ts`:

```ts
/** A JSON request to this plugin's own backend. `path` is relative: a `/`-led path would reach cc's API. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path.startsWith('/')) throw new Error(`api('${path}'): root-relative, so it would reach cc, not this plugin`);
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
```

## 11. Serving `frontend/dist` from the backend

`server.js` (Express):

```js
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'frontend', 'dist');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'";

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.json());
// …the plugin's API routes, under /api…

if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use((_req, res, next) => { res.set('Content-Security-Policy', CSP); next(); });
  app.use(express.static(dist));
} else {
  console.error(`UI not built: ${path.join(dist, 'index.html')} is missing — run npm install`);
  app.use((_req, res) => res.status(503).type('text/plain').send('UI not built — run npm install'));
}

app.listen(Number(process.env.PORT ?? 4000), '127.0.0.1');
```

- **Bind loopback only: `127.0.0.1`, never `0.0.0.0` or `::`.** The plugin's API has no authentication, so any interface beyond loopback lets anyone on the network drive it. cc's proxy reaches the backend over loopback.
- **Order:** the API routes, then the CSP, then `express.static`.
- **No SPA fallback:** an unknown path is a 404, so the host URLs 404 standalone (§6), and routes live in the query string (§5).
- `$PORT`, `healthPath` and the rest of the backend contract: [docs/plugins.md](plugins.md) → Plugin-compliance checklist (`<cc-checkout>/docs/plugins.md`, or `https://github.com/UnmanagedCode/code-conductor/blob/main/docs/plugins.md`).

## 12. Testing

`frontend/vitest.config.ts`:

```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
}));
```

`frontend/src/test/setup.ts`:

```ts
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);
```

- **Mock the network at `fetch`** (`vi.stubGlobal('fetch', …)`). Never start a server in a unit test.
- **Every plugin has these four tests:**

```tsx
// src/lib/security.test.tsx
import { render, renderHook, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { safeHref } from './safeHref';
import { useTheme } from './theme';
import { api } from './api';

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.classList.remove('dark'); });

it('renders model text as text, never as markup', () => {
  const evil = '<img src=x onerror="alert(1)">';
  // Render the component that shows model or user text, with `evil` as that text.
  const { container } = render(<p>{evil}</p>);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain(evil);
});

it('safeHref refuses javascript: and data: URLs', () => {
  expect(safeHref('javascript:alert(1)')).toBeNull();
  expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
});

it('useTheme follows a .dark flip on <html>', async () => {
  const { result } = renderHook(() => useTheme());
  expect(result.current).toBe('light');
  await act(async () => { document.documentElement.classList.add('dark'); });
  expect(result.current).toBe('dark');
  await act(async () => { document.documentElement.classList.remove('dark'); });
  expect(result.current).toBe('light');
});

it('API requests use relative URLs', async () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetchMock);
  await api('api/board');
  expect(fetchMock).toHaveBeenCalledWith('api/board', undefined);
  await expect(api('/api/board')).rejects.toThrow(/root-relative/);
});
```

- Replace the first test's `<p>{evil}</p>` with the plugin's own component that renders model or user text.
- **What happy-dom does not do:** no layout (every size reads 0), iframes are never loaded, and a theme flip under "system" needs `matchMedia` stubbed (`vi.stubGlobal('matchMedia', …)`) and its `change` listeners called by the test.

## 13. Checklists

**Standalone run:**
- [ ] `npm install` → `frontend/dist/index.html` exists.
- [ ] `PORT=<port> npm start` → `http://127.0.0.1:<port>/` loads.
- [ ] The backend listens on `127.0.0.1` only: `http://<this machine's LAN address>:<port>/` does not answer.
- [ ] Legible with the OS in light and in dark (DevTools → Rendering → Emulate CSS `prefers-color-scheme`), and it follows a flip live.
- [ ] The only console errors name the two host URLs, `/pluginBridge.js` and `/pluginTheme.css`: their 404, and the browser refusing the 404's HTML body as a script or stylesheet.
- [ ] `npm run dev` serves the UI with the API proxied to the backend.

**Fresh clone and install:**
- [ ] `git clone` → `npm install`, with no other step → `frontend/dist` is built.
- [ ] `git status` is clean afterwards.
- [ ] `npm test` is green.
- [ ] In cc, Settings → Plugins → Library → **Install** reports `postClone` ok.
- [ ] The plugin opens in cc, follows the sidebar theme toggle live, and follows the OS theme while cc's theme is "system".
- [ ] **Update** rebuilds `frontend/dist` and restarts the backend.
