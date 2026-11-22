import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Frame, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { installFakePlugin } from './harness/api.ts';

// cc hosted under /p/q behind a reverse proxy, framed same-origin by a host page — once behind a proxy that
// strips the prefix and once behind one that passes it through. Invariant: every request the browser makes
// lands under the prefix (the proxy answers anything else 404 and records it), the UI, its WebSocket, its
// plugin frames and its service worker all work under it, and cc's framing policy still holds.
const BASE = '/p/q';
test.use({ ccOptions: { server: 'base-path', env: { CC_BASE_PATH: BASE } } });

type Proxy = { url: string; escaped: string[]; close(): Promise<void> };

/** A host on its own origin: `/p/q/*` goes to cc (stripped or as-is), `/embed` frames cc, anything else 404s and is recorded. */
async function makeProxy(cc: Cc, mode: 'strip' | 'pass'): Promise<Proxy> {
  const escaped: string[] = [];
  const target = (url: string) => (mode === 'strip' ? url.slice(BASE.length) || '/' : url);
  const underBase = (url: string) => url === BASE || url.startsWith(`${BASE}/`) || url.startsWith(`${BASE}?`);
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/embed') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><link rel="icon" href="data:,"><body><iframe id="cc" src="${BASE}/" style="width:100%;height:800px"></iframe></body>`);
      return;
    }
    if (!underBase(url)) { escaped.push(url); res.statusCode = 404; res.end(); return; }
    if (mode === 'strip' && url === BASE) { res.writeHead(301, { location: `${BASE}/` }); res.end(); return; }
    const up = http.request({ host: '127.0.0.1', port: cc.port, method: req.method, path: target(url), headers: req.headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/';
    if (!underBase(url)) { escaped.push(`upgrade ${url}`); socket.destroy(); return; }
    const up = net.connect(cc.port, '127.0.0.1', () => {
      let raw = '';
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${req.method} ${target(url)} HTTP/1.1\r\n${raw}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, escaped, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const pluginFrame = (page: Page): Frame | undefined =>
  page.frames().find((f) => { try { return new URL(f.url()).pathname.startsWith(`${BASE}/plugins/fake-plugin/`); } catch { return false; } });

async function flow(page: Page, cc: Cc, mode: 'strip' | 'pass'): Promise<void> {
  await installFakePlugin(cc, 'base-path-plugin');
  const proxy = await makeProxy(cc, mode);
  try {
    // (a) the app renders in the frame, its WebSocket opens under the prefix and delivers frames, an /api read works.
    const wsOpened = page.waitForEvent('websocket', (ws) => ws.url().includes('/ws'));
    await page.goto(`${proxy.url}/embed`);
    const ws = await wsOpened;
    expect(new URL(ws.url()).pathname).toBe(`${BASE}/ws`);
    await ws.waitForEvent('framereceived');
    const ccFrame = page.frameLocator('#cc');
    await expect(ccFrame.locator('#root > *').first()).toBeVisible();
    const health = await page.evaluate(async (base) => (await fetch(`${base}/api/health`)).status, BASE);
    expect(health).toBe(200);
    // (d) the MCP surface answers under the prefix.
    expect(await page.evaluate(async (base) => (await fetch(`${base}/mcp/tools`)).status, BASE)).toBe(200);

    // (b) plugin pages: the base-safe one and the root-absolute one the proxy rewrites; both reach the bridge and the theme.
    const frame = page.frames().find((f) => f.url() === `${proxy.url}${BASE}/`)!;
    for (const sub of ['', 'legacy']) {
      await frame.evaluate((h) => { location.hash = h; }, `#plugin/fake-plugin/${sub}`);
      await expect.poll(() => pluginFrame(page)?.url() ?? '', { timeout: 20_000 }).toContain(`${BASE}/plugins/fake-plugin/${sub}`);
      const pf = pluginFrame(page)!;
      await expect.poll(() => pf.evaluate(() => document.documentElement.getAttribute('data-cc-theme')), 'the bridge applied the theme').not.toBeNull();
      await expect.poll(() => pf.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()), 'the theme sheet applied').not.toBe('');
    }

    // (c) top level: the service worker scopes to the prefix, the manifest and icons resolve under it.
    await page.goto(`${proxy.url}${BASE}/`);
    const sw = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(sw).toBe(`${proxy.url}${BASE}/`);
    const links = await page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel=manifest],link[rel=icon],link[rel=apple-touch-icon]')].map((l) => l.href));
    expect(links.length).toBeGreaterThan(1);
    for (const href of links) {
      expect(new URL(href).pathname.startsWith(`${BASE}/`), href).toBe(true);
      expect((await page.request.get(href)).status(), href).toBe(200);
    }

    // (e) a bare base lands on its slash form (cc redirects in pass mode, the proxy in strip mode).
    const bare = await page.request.get(`${proxy.url}${BASE}`, { maxRedirects: 0 });
    expect(bare.status()).toBe(301);
    expect(bare.headers().location).toBe(`${BASE}/`);

    // (g) cc's framing policy rides prefixed responses.
    expect((await page.request.get(`${proxy.url}${BASE}/`)).headers()['x-frame-options']).toBe('SAMEORIGIN');

    // (f) nothing escaped to the host root.
    expect(proxy.escaped).toEqual([]);
  } finally {
    await proxy.close();
  }
}

test('cc under /p/q behind a prefix-stripping proxy', async ({ page, cc }) => { await flow(page, cc, 'strip'); });
test('cc under /p/q behind a pass-through proxy', async ({ page, cc }) => { await flow(page, cc, 'pass'); });
