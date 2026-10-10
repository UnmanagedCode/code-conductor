// The sidebar's conductor ownership on a seeded fleet, in both UIs. A file of
// its own with its own cc: the live conductors it seeds would otherwise leak
// into the other parity files' Conductors-lens and strip scenarios. Each
// scenario seeds its own uniq-named fleet, because the two halves share the cc.
import type { Page } from '@playwright/test';
import { api, createProject, LIVE_WORKER_MODEL, mcpCall } from '../harness/api.ts';
import { expect, test, type Cc } from '../harness/fixtures.ts';
import { seedTranscript } from '../harness/transcript.ts';
import { parity } from './parity.ts';

test.use({ ccOptions: { server: 'sidebar-fleet' } });

type FleetInst = { id: string; sessionId: string; status: string; temp?: boolean; ownerSessionId?: string | null };

const insts = async (cc: Cc): Promise<FleetInst[]> => (await api<FleetInst[]>(cc, 'GET', '/api/instances')).body;
const liveModel = (cc: Cc) => (cc.engine === 'live' ? { model: LIVE_WORKER_MODEL } : {});

/** Waits until the instance `pred` matches is idle with a session id, and returns it. */
async function idleInst(cc: Cc, pred: (i: FleetInst) => boolean, what: string): Promise<FleetInst> {
  let found: FleetInst | undefined;
  await expect.poll(async () => {
    found = (await insts(cc)).find(pred);
    return found?.status === 'idle' && !!found.sessionId;
  }, { message: what, timeout: 20_000 }).toBe(true);
  return found!;
}

async function spawnConductor(cc: Cc, temp: boolean): Promise<FleetInst> {
  const r = await api(cc, 'POST', '/api/instances', {
    project: '.conduct', mode: 'bypassPermissions', temp, playbookEnforcement: 'warn', ...liveModel(cc),
  });
  expect(r.status, `POST /api/instances (.conduct): ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return idleInst(cc, (i) => i.id === r.body.id, `conductor ${r.body.id} idle`);
}

/** Spawns a worker through `spawn_instance` as the conductor whose instance id is `caller`. */
async function spawnWorker(cc: Cc, caller: string, args: Record<string, unknown>): Promise<FleetInst> {
  const r = await mcpCall(cc, 'spawn_instance', { mode: 'bypassPermissions', ...liveModel(cc), ...args }, caller);
  if (r.isError) throw new Error(`spawn_instance refused: ${r.content?.[0]?.text}`);
  const { sessionId } = JSON.parse(r.content[0].text);
  return idleInst(cc, (i) => i.sessionId === sessionId, `worker ${sessionId} idle`);
}

/** A conductor's colour resolved the way the page does, as a computed rgb(). */
const colourOf = (page: Page, sid: string) => page.evaluate(async ([s, mod]) => {
  const { conductorColor } = await import(mod);
  const probe = document.createElement('i');
  probe.style.color = conductorColor(s);
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, [sid, '/conductorColor.js'] as const);

const gone = (cc: Cc, id: string) =>
  expect.poll(async () => (await insts(cc)).some((i) => i.id === id), { message: `instance ${id} gone` }).toBe(false);

const archived = (cc: Cc, project: string, sid: string) =>
  expect.poll(async () => ((await api<{ sessionId: string; archived?: boolean }[]>(cc, 'GET', `/api/projects/${project}/sessions?includeArchived=1`)).body ?? [])
    .some((r) => r.sessionId === sid && r.archived === true), { message: `${sid} archived` }).toBe(true);

/**
 * Two live conductors in distinct colours — A temp and titled, B persistent and
 * untitled — with A's workers in a single-owner worktree `solo-a`, A's and B's
 * in a mixed worktree `mixed` beside a hand-spawned session, both in P's main
 * checkout, and one of B's in a second project O.
 */
async function seedFleet(cc: Cc, page: Page, uniq: (s: string) => string) {
  const P = uniq('fleet');
  const O = uniq('fleet-other');
  await createProject(cc, P);
  await createProject(cc, O);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const a = await spawnConductor(cc, true);
  const aLabel = uniq('Alpha');
  await api(cc, 'PUT', `/api/sessions/${a.sessionId}/title`, { title: aLabel });
  let b = await spawnConductor(cc, false);
  // Session ids are random, so A and B can share a hue slot: re-spawn B until they differ.
  const colA = await colourOf(page, a.sessionId);
  let colB = await colourOf(page, b.sessionId);
  for (let tries = 0; tries < 4 && colB === colA; tries++) {
    await api(cc, 'DELETE', `/api/instances/${b.id}`);
    b = await spawnConductor(cc, false);
    colB = await colourOf(page, b.sessionId);
  }
  expect(colB, 'A and B share a hue slot after 4 tries').not.toBe(colA);

  const aSolo = await spawnWorker(cc, a.id, { project: P, createWorktree: true, name: 'solo-a' });
  const aSolo2 = await spawnWorker(cc, a.id, { project: P, worktree: 'solo-a' });
  const aMixed = await spawnWorker(cc, a.id, { project: P, createWorktree: true, name: 'mixed' });
  const bMixed = await spawnWorker(cc, b.id, { project: P, worktree: 'mixed' });
  const aMain = await spawnWorker(cc, a.id, { project: P });
  const bMain = await spawnWorker(cc, b.id, { project: P });
  // A transcript makes its archive on kill observable as its row leaving.
  await seedTranscript(cc, bMain.id, 'bravo: main-checkout chore');
  const bOther = await spawnWorker(cc, b.id, { project: O });

  const handRes = await api(cc, 'POST', '/api/instances', { project: P, worktree: 'mixed', mode: 'bypassPermissions', temp: false, ...liveModel(cc) });
  expect(handRes.status, `POST /api/instances (hand): ${JSON.stringify(handRes.body)}`).toBeLessThan(300);
  const hand = await idleInst(cc, (i) => i.id === handRes.body.id, 'hand-spawned session idle');

  const workers = [aSolo, aSolo2, aMixed, bMixed, aMain, bMain, bOther].map((w) => w.sessionId);
  await expect.poll(async () => {
    const all = await insts(cc);
    return workers.every((sid) => all.find((i) => i.sessionId === sid)?.ownerSessionId);
  }, { message: 'every worker reports its owner', timeout: 20_000 }).toBe(true);

  return { P, O, aSid: a.sessionId, aLabel, colA, colB, aSolo, aSolo2, aMixed, bMixed, aMain, bMain, hand };
}

parity('legacy-sidebar-lenses/R7', 'the Projects lens lists no .conduct row while a conductor is live and .conduct has a disk row', async ({ page, cc, ui, uniq }) => {
  // Invariant: the Projects lens lists registered projects only; a live conductor with a conduct disk row adds no entry.
  const project = uniq('lens7');
  await createProject(cc, project);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const c = await spawnConductor(cc, false);
  await seedTranscript(cc, c.id, 'lens7 conductor');
  await expect.poll(async () => ((await api(cc, 'GET', '/api/projects/.conduct/sessions')).body as { sessionId: string }[]).some((r) => r.sessionId === c.sessionId)).toBe(true);
  await ui.open(page);
  await expect.poll(() => ui.projectNames(page)).toContain(project);
  expect((await ui.projectNames(page)).filter((n) => /conduct/i.test(n))).toEqual([]);
});

parity('legacy-sidebar-lenses/R8', 'owner bars on a seeded fleet: single, mixed and main checkout, the filter to one conductor, killed workers, and the selected row keeps its bar and reads bold', async ({ page, cc, ui, uniq }) => {
  // Invariant: bars follow live ownership per place in each conductor's colour, the filter narrows to one owner, and selection keeps the bar and reads bold.
  test.setTimeout(300_000);
  await ui.open(page);
  const f = await seedFleet(cc, page, uniq);
  const row = (sid: string) => ui.sessionRow(page, f.P, sid);

  await test.step('bars', async () => {
    await ui.openWorktrees(page, f.P);
    await expect.poll(async () => ui.ownerBar(await ui.worktreeHead(page, f.P, 'solo-a'))).toBe(f.colA);
    await expect(await row(f.aSolo.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.aSolo.sessionId))).toBeNull();
    await expect(await row(f.aSolo2.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.aSolo2.sessionId))).toBeNull();
    await expect(await row(f.aMixed.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.aMixed.sessionId))).toBe(f.colA);
    await expect(await row(f.bMixed.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.bMixed.sessionId))).toBe(f.colB);
    await expect(await row(f.hand.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.hand.sessionId))).toBeNull();
    await expect(await row(f.aMain.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.aMain.sessionId))).toBe(f.colA);
    await expect(await row(f.bMain.sessionId)).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await row(f.bMain.sessionId))).toBe(f.colB);
    await expect.poll(async () => ui.ownerBar(await ui.worktreeHead(page, f.P, 'mixed'))).toBeNull();
    await expect.poll(async () => ui.ownerBar(await ui.projectRow(page, f.P))).toBeNull();
  });

  await test.step('filter to A', async () => {
    // Closed first, so an open group after filtering can only be the filter's force-open.
    await ui.closeWorktrees(page, f.P);
    expect(await ui.worktreesOpen(page, f.P)).toBe(false);
    await ui.filterTo(page, f.aSid, f.aLabel);
    await expect.poll(() => ui.projectNames(page)).toContain(f.P);
    await expect.poll(() => ui.projectNames(page)).not.toContain(f.O);
    expect(await ui.worktreesOpen(page, f.P)).toBe(true);
    await expect.poll(async () => ui.ownerBar(await ui.worktreeHead(page, f.P, 'mixed'))).toBeNull();
    await expect.poll(async () => ui.ownerBar(await row(f.aMixed.sessionId))).toBe(f.colA);
    await expect(await row(f.bMixed.sessionId)).toHaveCount(0);
    await expect.poll(() => ui.filterBar(page)).toBe(f.colA);
    await ui.filterTo(page, '', 'All sessions');
    await expect.poll(() => ui.filterBar(page)).toBeNull();
    await expect.poll(() => ui.projectNames(page)).toContain(f.O);
  });

  await test.step('killed workers', async () => {
    await expect.poll(async () => ui.ownerBar(await row(f.bMain.sessionId))).toBe(f.colB);
    await api(cc, 'DELETE', `/api/instances/${f.bMain.id}`);
    await archived(cc, f.P, f.bMain.sessionId);
    // Legacy refetches its disk list on the instance broadcast, which can precede the archive, so the row may linger offline.
    await expect.poll(async (): Promise<'gone' | 'offline-unbarred' | 'other'> => {
      const r = await row(f.bMain.sessionId);
      if ((await r.count()) === 0) return 'gone';
      return !(await ui.sessionRowLive(r)) && (await ui.ownerBar(r)) === null ? 'offline-unbarred' : 'other';
    }).not.toBe('other');
    await expect.poll(async () => ui.ownerBar(await row(f.aMain.sessionId))).toBe(f.colA);

    const head = await ui.worktreeHead(page, f.P, 'solo-a');
    const handle = await head.elementHandle();
    await api(cc, 'DELETE', `/api/instances/${f.aSolo.id}`);
    await gone(cc, f.aSolo.id);
    await expect(await row(f.aSolo.sessionId)).toHaveCount(0);
    expect({ same: await head.evaluate((e, h) => e === h, handle), bar: await ui.ownerBar(head) }).toEqual({ same: true, bar: f.colA });
    await api(cc, 'DELETE', `/api/instances/${f.aSolo2.id}`);
    await gone(cc, f.aSolo2.id);
    await expect.poll(async () => ({ same: await head.evaluate((e, h) => e === h, handle), bar: await ui.ownerBar(head) }))
      .toEqual({ same: true, bar: null });
  });

  await test.step('selected row', async () => {
    let r = await row(f.aMain.sessionId);
    const before = await ui.sessionRowStyle(r);
    expect(before.framed).toBe(false);
    expect(Number(before.weight)).toBeLessThan(700);
    await r.click();
    await expect(ui.sessionHeader(page).locator(`[title="session ${f.aMain.sessionId}"]`)).toBeVisible();
    // Re-opens the phone drawer the selection closed.
    r = await row(f.aMain.sessionId);
    // Off the row, so its fill is the selection's, not hover's.
    await page.mouse.move(1, 1);
    await expect.poll(() => ui.sessionRowActive(r)).toBe(true);
    const after = await ui.sessionRowStyle(r);
    expect(after.framed).toBe(true);
    expect(after.fill).not.toBe(before.fill);
    expect(await ui.ownerBar(r)).toBe(f.colA);
    expect(after.weight).toBe('700');
  });
});
