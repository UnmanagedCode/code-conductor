// A browser that ran the plain-JS UI, upgraded: the old UI's root service
// worker is registered from web/e2e/fixtures/old-ui-sw (its sw.js and manifest
// as that UI shipped them), then cc starts on the same port and the browser
// loads /. These flows boot their own cc on a port they pick, so they take
// Playwright's own `test`, not the harness's worker `cc`. The bodies are shared
// by the per-project spec files; this module declares no tests.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { expect, type CDPSession, type Page, type Response } from '@playwright/test';
import { spawnSession } from './harness/api.ts';
import { bootCc, freePort, FIXTURES, type Cc } from './harness/boot.ts';
import { next } from './flows/ui.ts';

type Version = { registrationId: string; scriptURL: string; status: string };
type Upgraded = { cc: Cc; origin: string; versions: Map<string, Version>; v1: string; sessionId: string; responses: Response[] };

/** Serves the old UI's fixture on `port` until closed. */
async function oldUiServer(port: number): Promise<() => Promise<void>> {
  const server = http.createServer(express().use(express.static(path.join(FIXTURES, 'old-ui-sw'))));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
}

/** Every service-worker version the page's browser reports, by versionId, at its latest status. */
async function trackVersions(page: Page): Promise<Map<string, Version>> {
  const versions = new Map<string, Version>();
  const cdp: CDPSession = await page.context().newCDPSession(page);
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: vs }) => {
    for (const v of vs) versions.set(v.versionId, { registrationId: v.registrationId, scriptURL: v.scriptURL, status: v.status });
  });
  await cdp.send('ServiceWorker.enable');
  return versions;
}

/** Runs the upgrade; the caller closes the returned cc. */
async function upgrade(page: Page): Promise<Upgraded> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const versions = await trackVersions(page);

  const closeOld = await oldUiServer(port);
  try {
    await page.goto(`${origin}/`);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      { message: 'fixture check: the old UI\'s worker controls the page', timeout: 20_000 }).toBe(`${origin}/sw.js`);
  } finally { await closeOld(); }
  await expect.poll(() => [...versions.values()].filter((v) => v.status === 'activated').length,
    { message: 'fixture check: one activated version' }).toBe(1);
  const v1 = [...versions].find(([, v]) => v.status === 'activated')![0];

  const cc = await bootCc({ port });
  try {
    const { sessionId } = await spawnSession(cc, 'sw-upgrade');
    const responses: Response[] = [];
    page.on('response', (r) => responses.push(r));
    await page.goto(`${origin}/`);
    return { cc, origin, versions, v1, sessionId, responses };
  } catch (e) { await cc.close(); throw e; }
}

export async function workerReplacedFlow({ page }: { page: Page }): Promise<void> {
  const { cc, origin, versions, v1 } = await upgrade(page);
  try {
    await next.openSidebar(page);
    await expect(page.getByRole('tab', { name: 'Projects' }).filter({ visible: true }).first(), 'the web UI renders').toBeVisible();

    // Invariant: the web UI's worker replaces the old one in the same registration, which stays the only one.
    const reg = versions.get(v1)!.registrationId;
    await expect.poll(() => {
      const v2 = [...versions].find(([id, v]) => id !== v1 && v.registrationId === reg && v.status === 'activated');
      return { v2: v2 !== undefined, v1: versions.get(v1)!.status };
    }, { message: 'a new version activated in the old registration, and the old one is redundant', timeout: 20_000 }).toEqual({ v2: true, v1: 'redundant' });
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope))).toEqual([`${origin}/`]);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${origin}/sw.js`);
  } finally { await cc.close(); }
}

export async function nothingOldServedFlow({ page }: { page: Page }): Promise<void> {
  const { cc, origin, sessionId, responses } = await upgrade(page);
  try {
    await page.goto('about:blank');
    await page.goto(`${origin}/#session=${sessionId}`);
    await expect(next.sessionHeader(page), 'the anchored session opens').toBeVisible();

    // Invariant: after the upgrade no response comes from a service worker, and nothing of the old UI loads or is servable.
    expect(responses.length, 'fixture check: responses were recorded').toBeGreaterThan(0);
    expect(responses.filter((r) => r.fromServiceWorker()).map((r) => r.url())).toEqual([]);
    const old = responses.map((r) => new URL(r.url()).pathname).filter((p) => p === '/app.js' || p === '/styles.css' || p.startsWith('/legacy/'));
    expect(old).toEqual([]);
    expect((await page.request.get(`${origin}/app.js`)).status()).toBe(404);
  } finally { await cc.close(); }
}
