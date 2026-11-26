// A page marked `?focus=<sid>` is in focus mode on an ordinary server: one
// session, no sidebar, the marker kept through navigation and reload, and the
// same from a non-root path whose document carries `<base href="/">` (how a
// plugin route serves cc's page). Desktop and phone; the phone layout is the
// android one, so the android project does not run it.
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { api, createProject, mcpCall } from './harness/api.ts';
import { expect, test, type Cc } from './flows/test.ts';
import { spawnConductor, spawnWorker } from './flows/fleet.ts';

test.use({ ccOptions: { server: 'focus-url' } });

const PROBE = '/plugins/focus-probe/';
const emptyState = (page: import('@playwright/test').Page) => page.locator('[data-empty-state]');
const sidebar = (page: import('@playwright/test').Page) => page.locator('[data-sidebar]');
const openSidebarButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Open sidebar' });

/** A titled live conductor with one titled worker, in a project unique to this test project. */
async function fleet(cc: Cc, tag: string) {
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const conductor = await spawnConductor(cc, false);
  const project = `${tag}-${test.info().project.name}`;
  await createProject(cc, project);
  const worker = await spawnWorker(cc, conductor.sessionId, { project });
  const conductorTitle = `Conductor ${tag} ${test.info().project.name}`;
  const workerTitle = `Worker ${tag} ${test.info().project.name}`;
  await api(cc, 'PUT', `/api/sessions/${conductor.sessionId}/title`, { title: conductorTitle });
  await api(cc, 'PUT', `/api/sessions/${worker.sessionId}/title`, { title: workerTitle });
  return { conductor, worker, conductorTitle, workerTitle };
}

type Proxy = { url: string; close(): Promise<void> };

/** A host on its own origin: `/plugins/focus-probe/` answers cc's `/` document with `<base href="/">` injected; everything else, upgrades included, goes to cc. */
async function makeProxy(cc: Cc): Promise<Proxy> {
  const upgraded = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const isProbe = new URL(url, 'http://h').pathname === PROBE;
    const headers = { ...req.headers };
    if (isProbe) delete headers['accept-encoding'];
    const up = http.request({ host: '127.0.0.1', port: cc.port, method: req.method, path: isProbe ? '/' : url, headers }, (upRes) => {
      if (!isProbe) { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); return; }
      const chunks: Buffer[] = [];
      upRes.on('data', (c: Buffer) => chunks.push(c));
      upRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replace(/<head[^>]*>/i, (m) => `${m}<base href="/">`);
        const out = { ...upRes.headers };
        delete out['content-length'];
        res.writeHead(upRes.statusCode ?? 502, out);
        res.end(html);
      });
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(cc.port, '127.0.0.1', () => {
      let raw = '';
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${raw}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    upgraded.add(socket);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    socket.on('close', () => { upgraded.delete(socket); up.destroy(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((resolve) => { for (const s of upgraded) s.destroy(); server.closeAllConnections(); server.close(() => resolve()); }) };
}

// Invariant: the marker alone removes every sidebar path; the conductor opens; a worker switch keeps the marker and the layout; Back returns to the conductor; a reload on the worker stays on it.
test('?focus=<conductor>: no sidebar, the conductor opens, a worker switch keeps the marker, Back and reload hold', async ({ page, cc, ui }) => {
  const f = await fleet(cc, 'fu');
  await page.goto(`/?focus=${f.conductor.sessionId}`);
  await expect(ui.sessionHeader(page)).toContainText(f.conductorTitle);
  await expect(ui.workersPanel(page)).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(openSidebarButton(page)).toHaveCount(0);

  await ui.openWorker(page, f.workerTitle);
  await expect(ui.sessionHeader(page)).toContainText(f.workerTitle);
  await expect(page).toHaveURL(new RegExp(`\\?focus=${f.conductor.sessionId}#session=${f.worker.sessionId}$`));
  await expect(sidebar(page)).toHaveCount(0);
  await expect(openSidebarButton(page)).toHaveCount(0);

  await page.goBack();
  await expect(ui.sessionHeader(page)).toContainText(f.conductorTitle);
  await expect(page).toHaveURL(new RegExp(`\\?focus=${f.conductor.sessionId}`));

  await page.goForward();
  await expect(ui.sessionHeader(page)).toContainText(f.workerTitle);
  await page.reload();
  await expect(ui.sessionHeader(page)).toContainText(f.workerTitle);
  await expect(sidebar(page)).toHaveCount(0);
  await expect(openSidebarButton(page)).toHaveCount(0);
});

// Invariant (control): without the marker the same session shows the sidebar column (desktop) or its Open sidebar button (phone).
test('control: without ?focus= the sidebar is there', async ({ page, cc, ui }) => {
  const f = await fleet(cc, 'fc');
  await page.goto(`/#session=${f.conductor.sessionId}`);
  await expect(ui.sessionHeader(page)).toContainText(f.conductorTitle);
  if (test.info().project.name === 'desktop') await expect(sidebar(page)).toBeVisible();
  else await expect(openSidebarButton(page).first()).toBeVisible();
});

// Invariant: cc's page served from a non-root path with `<base href="/">` keeps working under the marker — its WebSocket opens at /ws, the session renders without a sidebar, and a worker switch and a Settings section link keep the pathname and the query.
test('?focus= from a non-root path with <base href="/">', async ({ page, cc, ui }) => {
  const f = await fleet(cc, 'fp');
  const proxy = await makeProxy(cc);
  try {
    const wsOpened = page.waitForEvent('websocket', (ws) => ws.url().includes('/ws'));
    await page.goto(`${proxy.url}${PROBE}?focus=${f.conductor.sessionId}`);
    const ws = await wsOpened;
    expect(new URL(ws.url()).pathname).toBe('/ws');
    await ws.waitForEvent('framereceived');
    await expect(ui.sessionHeader(page)).toContainText(f.conductorTitle);
    await expect(sidebar(page)).toHaveCount(0);

    await ui.openWorker(page, f.workerTitle);
    await expect(ui.sessionHeader(page)).toContainText(f.workerTitle);
    expect(new URL(page.url()).pathname).toBe(PROBE);
    expect(new URL(page.url()).searchParams.get('focus')).toBe(f.conductor.sessionId);

    await page.goto(`${proxy.url}${PROBE}?focus=${f.conductor.sessionId}#settings`);
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav).toBeVisible();
    await nav.getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/#settings\/./);
    expect(new URL(page.url()).pathname).toBe(PROBE);
    expect(new URL(page.url()).searchParams.get('focus')).toBe(f.conductor.sessionId);
  } finally {
    await proxy.close();
  }
});

// Invariant: an unknown marked id shows focus mode's empty state — no sidebar, no way to start a session.
test('?focus=<unknown>: the focus empty state, no sidebar, no Start conducting', async ({ page }) => {
  await page.goto('/?focus=nope');
  await expect(emptyState(page)).toBeVisible();
  await expect(emptyState(page)).toContainText('Waiting for the session to start.');
  await expect(page.getByRole('button', { name: /Start conducting/ })).toHaveCount(0);
  await expect(sidebar(page)).toHaveCount(0);
  await expect(openSidebarButton(page)).toHaveCount(0);
});

// Invariant: a marked session that ends while watched keeps its read-only pane, with Resume under `full` (the marker does not move the access mode), and the page stays sidebar-free. (The fake CLI writes no session jsonl, so a worker killed before load is unknown to the server: the kill happens with the page open.)
test('?focus=<worker> killed while watched: the ended pane with Resume, no sidebar', async ({ page, cc, ui }) => {
  const f = await fleet(cc, 'fe');
  await page.goto(`/?focus=${f.worker.sessionId}`);
  await expect(ui.sessionHeader(page)).toContainText(f.workerTitle);
  const killed = await mcpCall(cc, 'kill_instance', { sessionId: f.worker.sessionId });
  expect(killed.isError, JSON.stringify(killed.content)).toBeFalsy();
  const banner = page.locator('[data-session-ended]');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
});
