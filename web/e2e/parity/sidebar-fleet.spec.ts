// The sidebar's conductor ownership on a seeded fleet, in both UIs. A file of
// its own with its own cc: the live conductors it seeds would otherwise leak
// into the other parity files' Conductors-lens and strip scenarios. Each
// scenario seeds its own uniq-named fleet, because the two halves share the cc.
import type { Page } from '@playwright/test';
import { api, createProject } from '../harness/api.ts';
import { expect, test, type Cc } from './test.ts';
import { seedTranscript } from '../harness/transcript.ts';
import { archived, colourOf, gone, idleInst, insts, liveModel, spawnConductor, spawnWorker } from './fleet.ts';
import type { Ui } from './ui.ts';

test.use({ ccOptions: { server: 'sidebar-fleet' } });

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

  return { P, O, a, b, aSid: a.sessionId, aLabel, colA, colB, aSolo, aSolo2, aMixed, bMixed, aMain, bMain, bOther, hand };
}

test('the Projects lens lists no .conduct row while a conductor is live and .conduct has a disk row', async ({ page, cc, ui, uniq }) => {
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

test('owner bars on a seeded fleet: single, mixed and main checkout, the filter to one conductor, killed workers, and the selected row is marked and keeps its bar', async ({ page, cc, ui, uniq }) => {
  // Invariant: bars follow live ownership per place in each conductor's colour, the filter narrows to one owner, and selection marks exactly the picked row, fills it unlike an unselected one, and keeps its bar.
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
    // A row's fill transitions, so each read waits until three reads 250ms apart agree: a mid-transition value would differ from any other row's whether or not the row has a fill of its own.
    const settledFill = async (sid: string) => {
      const reads: string[] = [];
      await expect.poll(async () => {
        reads.push((await ui.sessionRowStyle(await row(sid))).fill);
        return reads.length >= 3 && reads.slice(-3).every((x) => x === reads[reads.length - 1]);
      }, { intervals: [250], timeout: 15_000 }).toBe(true);
      return reads[reads.length - 1];
    };
    let r = await row(f.aMain.sessionId);
    const before = await ui.sessionRowStyle(r);
    expect(before.active).toBe(false);
    expect(before.colour).toBe(f.colA);
    await r.click();
    await expect(ui.sessionHeader(page).locator(`[title="session ${f.aMain.sessionId}"]`)).toBeVisible();
    // Re-opens the phone drawer the selection closed.
    r = await row(f.aMain.sessionId);
    // Off the row, so its fill is the selection's, not hover's.
    await page.mouse.move(1, 1);
    await expect.poll(() => ui.sessionRowActive(r)).toBe(true);
    const after = await ui.sessionRowStyle(await row(f.aMain.sessionId));
    expect(after.active).toBe(true);
    expect(after.colour).toBe(f.colA);
    // Invariant: the selected row's settled fill differs from an unselected row's settled fill, so it fails when selection draws no fill of its own.
    const other = await ui.sessionRowStyle(await row(f.aMixed.sessionId));
    expect(other.active).toBe(false);
    expect(await settledFill(f.aMain.sessionId)).not.toBe(await settledFill(f.aMixed.sessionId));
  });
});

// Sidebar B3 (card 2026-0642)
const BARE = { sessions: false, worktrees: false, rows: 0, hint: false };
/** `sid`'s row in the .conduct disk list, or null. */
const conductRow = async (cc: Cc, sid: string) =>
  ((await api<{ sessionId: string; firstPrompt?: string | null }[]>(cc, 'GET', '/api/projects/.conduct/sessions')).body ?? [])
    .find((r) => r.sessionId === sid) ?? null;

/**
 * The fleet, with B labelled by a first prompt on disk (so it stays a conductor
 * once its instance is gone), then the page re-opened so both UIs load the spawn
 * history the fleet recorded.
 */
async function seedFilterFleet(cc: Cc, page: Page, ui: Ui, uniq: (s: string) => string, tag: string) {
  const u = (s: string) => uniq(`${tag}-${s}`);
  await ui.open(page);
  const f = await seedFleet(cc, page, u);
  const bLabel = u('bravo');
  await seedTranscript(cc, f.b.id, bLabel);
  await expect.poll(async () => (await conductRow(cc, f.b.sessionId))?.firstPrompt ?? null, { message: "B's transcript lists it under .conduct" })
    .toBe(bLabel);
  await ui.open(page);
  await expect.poll(() => ui.projectNames(page)).toEqual(expect.arrayContaining([f.P, f.O]));
  await expect(await ui.sessionRow(page, f.P, f.bMain.sessionId)).toHaveCount(1);
  return { ...f, bSid: f.b.sessionId, bLabel };
}

test("the conductor filter in a browser: a conductor narrows the tree, force-opens Worktrees and colours the root, survives the drawer, Hand-spawned only keeps hand rows, and All restores the user's expansion", async ({ page, cc, ui, uniq }) => {
  // Invariant: an owner filter narrows to its projects, worktrees and rows, force-opens Worktrees unrecorded and colours its root, and survives the drawer; Hand-spawned only keeps hand places and rows, uncoloured and unforced; All restores the tree.
  test.setTimeout(300_000);
  const E = uniq('fleet-empty');
  await createProject(cc, E);
  const f = await seedFilterFleet(cc, page, ui, uniq, 'filter');
  const row = (sid: string) => ui.sessionRow(page, f.P, sid);

  await test.step('All', async () => {
    await ui.openWorktrees(page, f.P);
    await expect.poll(() => ui.conductedSeparator(page, f.P, 'mixed')).toBe(true);
    await expect(await ui.sessionsSummary(page, f.P, null)).toHaveCount(1);
    await expect.poll(() => ui.projectNames(page)).toEqual(expect.arrayContaining([f.P, f.O, E]));
    await ui.closeWorktrees(page, f.P);
  });

  await test.step('filter to B', async () => {
    await ui.filterTo(page, f.bSid, f.bLabel);
    await expect.poll(() => ui.projectNames(page)).not.toContain(E);
    expect(await ui.projectNames(page)).toEqual(expect.arrayContaining([f.P, f.O]));
    expect(await ui.worktreesOpen(page, f.P)).toBe(true);
    await expect(await ui.worktreeHead(page, f.P, 'mixed')).toHaveCount(1);
    await expect.poll(async () => ui.ownerBar(await ui.worktreeHead(page, f.P, 'mixed'))).toBeNull();
    await expect(await ui.worktreeHead(page, f.P, 'solo-a')).toHaveCount(0);
    await expect.poll(async () => ui.ownerBar(await row(f.bMixed.sessionId))).toBe(f.colB);
    await expect.poll(async () => ui.ownerBar(await row(f.bMain.sessionId))).toBe(f.colB);
    await expect(await row(f.aMixed.sessionId)).toHaveCount(0);
    await expect(await row(f.aMain.sessionId)).toHaveCount(0);
    await expect(await row(f.hand.sessionId)).toHaveCount(0);
    await expect.poll(() => ui.filterBar(page)).toBe(f.colB);
    await ui.closeSidebar(page);
    expect(await ui.filterValue(page)).toBe(f.bSid);
    await expect.poll(() => ui.filterBar(page)).toBe(f.colB);
  });

  await test.step('All restores the closed Worktrees group', async () => {
    await ui.filterTo(page, '', 'All sessions');
    await expect.poll(() => ui.projectNames(page)).toContain(E);
    expect(await ui.worktreesOpen(page, f.P)).toBe(false);
    expect(await ui.filterBar(page)).toBeNull();
  });

  await test.step('Hand-spawned only', async () => {
    await ui.filterTo(page, 'hand', 'Hand-spawned only');
    await expect.poll(() => ui.projectNames(page)).not.toContain(f.O);
    expect(await ui.projectNames(page)).toContain(f.P);
    expect(await ui.projectNames(page)).not.toContain(E);
    expect(await ui.filterBar(page)).toBeNull();
    expect(await ui.worktreesOpen(page, f.P)).toBe(false);
    await expect(await ui.sessionsSummary(page, f.P, null)).toHaveCount(0);
    await ui.openWorktrees(page, f.P);
    await expect(await ui.worktreeHead(page, f.P, 'mixed')).toHaveCount(1);
    await expect(await ui.worktreeHead(page, f.P, 'solo-a')).toHaveCount(0);
    await expect(await row(f.hand.sessionId)).toHaveCount(1);
    await expect(await row(f.aMixed.sessionId)).toHaveCount(0);
    await expect(await row(f.bMixed.sessionId)).toHaveCount(0);
    await expect.poll(() => ui.conductedSeparator(page, f.P, 'mixed')).toBe(false);
  });

  await test.step('back to All', async () => {
    await ui.filterTo(page, '', 'All sessions');
    await expect.poll(() => ui.projectNames(page)).toEqual(expect.arrayContaining([f.O, E]));
    await expect.poll(() => ui.conductedSeparator(page, f.P, 'mixed')).toBe(true);
  });
});

test('the conductor filter keeps a conductor with idle chips, listing them as bare rows, and falls back to All once nothing offers its owner', async ({ page, cc, ui, uniq }) => {
  // Invariant: a conductor stays offered and selected while it has a live worker or a registered idle chip, live or inactive, with its idle projects listed bare; a dead conductor with no disk row is not offered, and its filter falls back to All.
  test.setTimeout(300_000);
  const f = await seedFilterFleet(cc, page, ui, uniq, 'chips');
  expect(await conductRow(cc, f.aSid), 'A has no .conduct disk row').toBeNull();

  await test.step('idle beside live', async () => {
    await api(cc, 'DELETE', `/api/instances/${f.bOther.id}`);
    await gone(cc, f.bOther.id);
    await ui.filterTo(page, f.bSid, f.bLabel);
    await expect.poll(() => ui.projectNames(page)).toEqual(expect.arrayContaining([f.P, f.O]));
    await expect.poll(() => ui.projectParts(page, f.O)).toEqual(BARE);
    expect(await ui.projectParts(page, f.P)).toMatchObject({ sessions: true, worktrees: true });
  });

  await test.step('keeps its entry after its last worker', async () => {
    await api(cc, 'DELETE', `/api/instances/${f.bMixed.id}`);
    await gone(cc, f.bMixed.id);
    await api(cc, 'DELETE', `/api/instances/${f.bMain.id}`);
    await gone(cc, f.bMain.id);
    await expect.poll(() => ui.projectParts(page, f.P)).toEqual(BARE);
    expect(await ui.projectParts(page, f.O)).toEqual(BARE);
    expect(await ui.filterValue(page)).toBe(f.bSid);
    expect(await ui.filterOptions(page)).toContain(f.bLabel);
    expect(await ui.filterBar(page)).toBe(f.colB);
  });

  await test.step('an inactive conductor keeps its entry', async () => {
    await api(cc, 'DELETE', `/api/instances/${f.b.id}`);
    await gone(cc, f.b.id);
    expect(await conductRow(cc, f.bSid), "B's transcript stays under .conduct").not.toBeNull();
    await expect.poll(() => ui.filterOptions(page)).toContain(f.bLabel);
    expect(await ui.filterValue(page)).toBe(f.bSid);
    expect(await ui.projectNames(page)).toEqual(expect.arrayContaining([f.P, f.O]));
    expect(await ui.projectParts(page, f.P)).toEqual(BARE);
    expect(await ui.projectParts(page, f.O)).toEqual(BARE);
  });

  await test.step('falls back to All', async () => {
    await ui.filterTo(page, f.aSid, f.aLabel);
    await expect.poll(() => ui.projectNames(page)).not.toContain(f.O);
    await api(cc, 'DELETE', `/api/instances/${f.aSolo.id}`);
    await gone(cc, f.aSolo.id);
    await api(cc, 'DELETE', `/api/instances/${f.aSolo2.id}`);
    await gone(cc, f.aSolo2.id);
    await api(cc, 'DELETE', `/api/instances/${f.aMixed.id}`);
    await gone(cc, f.aMixed.id);
    await api(cc, 'DELETE', `/api/instances/${f.aMain.id}`);
    await gone(cc, f.aMain.id);
    // A is still a live conductor with an idle chip in P: still offered.
    expect(await ui.filterValue(page)).toBe(f.aSid);
    await api(cc, 'DELETE', `/api/instances/${f.a.id}`);
    await gone(cc, f.a.id);
    expect(await conductRow(cc, f.aSid), 'A left no .conduct disk row').toBeNull();
    await expect.poll(() => ui.filterValue(page)).toBe('');
    expect(await ui.filterBar(page)).toBeNull();
    const options = await ui.filterOptions(page);
    expect(options).not.toContain(f.aLabel);
    expect(options).toContain(f.bLabel);
    await expect.poll(() => ui.projectNames(page)).toEqual(expect.arrayContaining([f.P, f.O]));
  });
});

// Sidebar B4 (card 2026-0643)
/** Unassigned projects listing above a scenario's fleet, enough to push its rows below the fold of every project's sidebar. */
const FILLERS = 30;
/** A uniq under a tag: each B4 scenario names its own projects, workspaces and labels. */
const tagged = (uniq: (s: string) => string, tag: string) => (s: string) => uniq(`${tag}-${s}`);
/** Assigns `project` to `workspace`, registering the workspace. */
async function setWorkspace(cc: Cc, project: string, workspace: string) {
  const r = await api(cc, 'PUT', `/api/projects/${project}/workspace`, { workspace });
  expect(r.status, `PUT /api/projects/${project}/workspace: ${JSON.stringify(r.body)}`).toBeLessThan(300);
}
/** The fleet under `u`, then the page re-opened once P lists A's main-checkout row. */
async function seedRevealFleet(cc: Cc, page: Page, ui: Ui, u: (s: string) => string) {
  await ui.open(page);
  const f = await seedFleet(cc, page, u);
  await ui.open(page);
  await expect.poll(() => ui.projectNames(page)).toContain(f.P);
  await expect(await ui.sessionRow(page, f.P, f.aMain.sessionId)).toHaveCount(1);
  return f;
}
/** The session header names `sid`: the selection landed. */
const landed = (page: Page, ui: Ui, sid: string) => expect(ui.sessionHeader(page).locator(`[title="session ${sid}"]`)).toBeVisible();

test("reveal on select in a browser: a Conductors-lens pick opens its workspace and Worktrees group and nothing off its path, a Projects-lens pick opens its owner's bubble only, a group revealed under an owner filter stays open after All, and a conductor pick changes nothing", async ({ page, cc, ui, uniq }) => {
  // Invariant: a worker's selection opens exactly its own path in each lens (its workspace, Worktrees group and owner bubble) and records it; a conductor's selection opens nothing and keeps the filter.
  test.setTimeout(300_000);
  const u = tagged(uniq, 'reveal');
  const f = await seedRevealFleet(cc, page, ui, u);
  const bSid = f.b.sessionId;
  const W = u('ws-a');
  const W2 = u('ws-b');
  try {
    await setWorkspace(cc, f.P, W);
    await setWorkspace(cc, f.O, W2);
    await ui.open(page);
    await expect(await ui.workspaceHeader(page, W)).toHaveCount(1);
    await expect(await ui.workspaceHeader(page, W2)).toHaveCount(1);

    await test.step('a Conductors-lens pick opens its Projects-lens path only', async () => {
      // A fresh profile: every workspace and bubble starts closed.
      expect(await ui.workspaceOpen(page, W)).toBe(false);
      expect(await ui.workspaceOpen(page, W2)).toBe(false);
      expect(await ui.conductorOpen(page, bSid)).toBe(false);
      await (await ui.treeWorkerRow(page, f.aSid, f.aSolo.sessionId)).click();
      await landed(page, ui, f.aSolo.sessionId);
      await expect.poll(() => ui.workspaceOpen(page, W)).toBe(true);
      expect(await ui.worktreesOpen(page, f.P)).toBe(true);
      expect(await ui.sessionRowActive(await ui.sessionRow(page, f.P, f.aSolo.sessionId))).toBe(true);
      expect(await ui.workspaceOpen(page, W2)).toBe(false);
      expect(await ui.conductorOpen(page, bSid)).toBe(false);
    });

    await test.step("a Projects-lens pick opens its owner's bubble only", async () => {
      await ui.closeConductor(page, f.aSid);
      await (await ui.sessionRow(page, f.P, f.bMixed.sessionId)).click();
      await landed(page, ui, f.bMixed.sessionId);
      await expect.poll(() => ui.conductorOpen(page, bSid)).toBe(true);
      expect(await ui.conductorOpen(page, f.aSid)).toBe(false);
      expect(await ui.sessionRowActive(await ui.treeWorkerRow(page, bSid, f.bMixed.sessionId))).toBe(true);
    });

    await test.step('a group revealed under an owner filter stays open after All', async () => {
      await ui.closeWorktrees(page, f.P);
      await ui.filterTo(page, f.aSid, f.aLabel);
      expect(await ui.worktreesOpen(page, f.P)).toBe(true);
      await (await ui.sessionRow(page, f.P, f.aMixed.sessionId)).click();
      await landed(page, ui, f.aMixed.sessionId);
      await ui.filterTo(page, '', 'All sessions');
      await expect.poll(() => ui.worktreesOpen(page, f.P)).toBe(true);
      expect(await ui.workspaceOpen(page, W2)).toBe(false);
    });

    await test.step('a conductor pick changes neither the filter nor any group', async () => {
      // Step 3's pick re-opened A's bubble: close both, so each closed read below can only fail by the pick opening it.
      await ui.closeConductor(page, f.aSid);
      await ui.closeConductor(page, bSid);
      await ui.filterTo(page, f.aSid, f.aLabel);
      await ui.openConductor(page, bSid);
      await landed(page, ui, bSid);
      expect(await ui.conductorOpen(page, bSid)).toBe(false);
      expect(await ui.conductorOpen(page, f.aSid)).toBe(false);
      expect(await ui.filterValue(page)).toBe(f.aSid);
      expect(await ui.workspaceOpen(page, W)).toBe(true);
    });
  } finally {
    await api(cc, 'DELETE', `/api/workspaces/${W}`);
    await api(cc, 'DELETE', `/api/workspaces/${W2}`);
  }
});

test('a re-selection of the selected session re-opens the groups the user collapsed on its path, in both lenses', async ({ page, cc, ui, uniq }) => {
  // Invariant: every selection reveals, the selected session's included, so a click on the selected row re-opens its owner bubble and its Worktrees group.
  test.setTimeout(300_000);
  const f = await seedRevealFleet(cc, page, ui, tagged(uniq, 'reselect'));

  await test.step('the first selection reveals', async () => {
    await ui.openWorktrees(page, f.P);
    await (await ui.sessionRow(page, f.P, f.aMixed.sessionId)).click();
    await landed(page, ui, f.aMixed.sessionId);
    await expect.poll(() => ui.conductorOpen(page, f.aSid)).toBe(true);
  });

  await test.step('re-selecting from the Projects lens re-opens the owner bubble', async () => {
    await ui.closeConductor(page, f.aSid);
    expect(await ui.conductorOpen(page, f.aSid)).toBe(false);
    await (await ui.sessionRow(page, f.P, f.aMixed.sessionId)).click();
    await expect.poll(() => ui.conductorOpen(page, f.aSid)).toBe(true);
  });

  await test.step('re-selecting from the Conductors lens re-opens the Worktrees group', async () => {
    await ui.closeWorktrees(page, f.P);
    await (await ui.treeWorkerRow(page, f.aSid, f.aMixed.sessionId)).click();
    await expect.poll(() => ui.worktreesOpen(page, f.P)).toBe(true);
  });
});

test('the sidebar keeps its scroll offset across the phone drawer closing and re-opening, so a row tapped deep in the list is in view when it re-opens', async ({ page, cc, ui, uniq }) => {
  // Invariant: the sidebar's scroll offset outlives the drawer closing, so the drawer re-opens where the user left it, on the row they tapped.
  test.setTimeout(300_000);
  const u = tagged(uniq, 'drawer');
  // `drawer-fill-…` sorts before `drawer-fleet-…`, so every filler lists above P.
  const fillers = Array.from({ length: FILLERS }, (_, n) => u(`fill-${String(n).padStart(2, '0')}`));
  try {
    for (const name of fillers) await createProject(cc, name);
    const f = await seedRevealFleet(cc, page, ui, u);

    await test.step('a scrolled drawer keeps its offset', async () => {
      await ui.lens(page, 'projects');
      const top = await ui.scrollSidebar(page, 400);
      expect(top, 'fixture: the list is tall enough to scroll 400px').toBe(400);
      await ui.closeSidebar(page);
      await expect.poll(() => ui.sidebarScroll(page)).toBe(top);
    });

    await test.step('a row tapped deep in the list is in view when the drawer re-opens', async () => {
      const sid = f.aMain.sessionId;
      const row = await ui.sessionRow(page, f.P, sid);
      await expect(row).toHaveCount(1);
      await expect(row, 'fixture: the row sits below the fold').not.toBeInViewport();
      await row.click();
      await landed(page, ui, sid);
      const selected = await ui.selectedProjectsRow(page);
      await expect(selected).toHaveCount(1);
      expect(await selected.getAttribute('title')).toMatch(new RegExp(`^${sid}`));
      await expect(selected).toBeInViewport();
    });
  } finally {
    for (const name of fillers) await api(cc, 'DELETE', `/api/projects/${name}`, { deleteDirectory: true });
  }
});
