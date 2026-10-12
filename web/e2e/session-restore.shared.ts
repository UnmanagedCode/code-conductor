// The web UI's restore of the session a URL names, on a real cc: on a first
// load the named session opens from the first instance-list read even while a
// newer read, started by the server's `instances` hint, is still in flight, and
// stays open once that read lands. Closing the open session drops its anchor
// with a replace, so a reload resumes nothing. The bodies are shared by the
// per-project spec files; this module declares no tests.
import type { Page, Route, WebSocketRoute } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { seedTranscript } from './harness/transcript.ts';
import { next } from './flows/ui.ts';

type Args = { page: Page; cc: Cc };

export async function overtakenListReadFlow({ page, cc }: Args): Promise<void> {
  const { sessionId } = await spawnSession(cc, `restore-${test.info().project.name}`);
  // The hint goes into the page's own socket while its first list read is held, so a second read starts behind it.
  const socket: { route: WebSocketRoute | null } = { route: null };
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); socket.route = ws; });
  const reads: Route[] = [];
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET' || reads.length >= 2) return route.continue();
    reads.push(route);
    if (reads.length > 1) return;
    if (!socket.route) throw new Error("fixture check: the page's socket was routed");
    socket.route.send(JSON.stringify({ t: 'instances' }));
  });
  const anchored = new RegExp(`/next/#session=${sessionId}$`);

  await page.goto(`/next/#session=${sessionId}`);
  await expect.poll(() => reads.length, { message: 'fixture check: the hint started a second read while the first was held' }).toBe(2);
  const [first, second] = reads;
  const firstLanded = page.waitForResponse((r) => r.request() === first.request());
  await first.continue();
  await firstLanded;

  // Invariant: the first read's list opens the named session, the newer read still in flight.
  await expect(next.sessionHeader(page), 'the named session opened').toBeVisible();
  await expect(page).toHaveURL(anchored);
  await expect(next.composer(page)).toBeEnabled();

  // Invariant: the newer read landing keeps it open.
  const secondLanded = page.waitForResponse((r) => r.request() === second.request());
  await second.continue();
  await secondLanded;
  await expect(next.sessionHeader(page)).toBeVisible();
  await expect(page).toHaveURL(anchored);
}

export async function closeThenReloadFlow({ page, cc }: Args): Promise<void> {
  const project = `close-${test.info().project.name}`;
  const closed = await spawnSession(cc, project);
  const marker = await spawnSession(cc, project);
  // fake-claude writes no transcript: with one on disk the stopped session stays resumable, so a reload would resume it.
  await seedTranscript(cc, closed.id, 'close me');
  const anchored = new RegExp(`/next/#session=${closed.sessionId}$`);
  await page.goto(`/next/#session=${closed.sessionId}`);
  await expect(next.sessionHeader(page), 'fixture check: the named session opened').toBeVisible();
  await expect(page).toHaveURL(anchored);
  const entries = await page.evaluate(() => history.length);

  await next.sessionClose(await next.sessionRow(page, project, closed.sessionId)).click();
  // Invariant: the close drops the anchor naming the closed session, replacing the entry rather than adding one.
  await expect(page).toHaveURL(/\/next\/$/);
  expect(await page.evaluate(() => history.length)).toBe(entries);

  const restores: string[] = [];
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.endsWith('/locate') || (r.method() === 'POST' && pathname === '/api/instances')) restores.push(`${r.method()} ${pathname}`);
  });
  await page.reload();
  // The marker's live dot is drawn from the first applied instance list, after which the restore has already run.
  await expect.poll(async () => next.sessionRowLive(await next.sessionRow(page, project, marker.sessionId)), { message: 'fixture check: the instance list landed' }).toBe(true);
  // Invariant: the reload resumes nothing and opens no session.
  expect(restores).toEqual([]);
  await expect(next.sessionHeader(page)).toHaveCount(0);

  // Control: the same reload with the anchor still naming the session resumes and opens it.
  await page.evaluate((sid) => history.replaceState(null, '', `/next/#session=${sid}`), closed.sessionId);
  const resume = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await page.reload();
  await resume;
  await expect(next.sessionHeader(page), 'control: an anchor naming the session resumes it').toBeVisible();
}
