// The web UI's restore of the session a URL names, on a real cc: on a first
// load the named session opens from the first instance-list read even while a
// newer read, started by the server's `instances` hint, is still in flight, and
// stays open once that read lands. The body is shared by the per-project spec
// files; this module declares no tests.
import type { Page, Route, WebSocketRoute } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './parity/ui.ts';

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
