// The Conductors lens's rows in both UIs. A file of its own with its own cc: the live conductors it seeds would leak into the shared parity cc. Each scenario seeds its own uniq-named conductors, because the two halves share the cc.
import { api, createProject } from '../harness/api.ts';
import { expect, test, type Cc } from '../harness/fixtures.ts';
import { seedTranscript } from '../harness/transcript.ts';
import { colourOf, gone, idleInst, liveModel, spawnConductor, spawnWorker } from './fleet.ts';
import { parity } from './parity.ts';

test.use({ ccOptions: { server: 'sidebar-conductors' } });
const desktop = () => test.info().project.name === 'desktop';

/**
 * Two live conductors — A temp and titled, B persistent and untitled — with A
 * holding a live worker in P and a killed one in Q, so A shows a live chip P
 * and an idle chip Q. Seeded before `ui.open`, so the first sidebar fetch
 * already carries the spawn history the chips read.
 */
async function seedPair(cc: Cc, uniq: (s: string) => string) {
  const P = uniq('cond');
  const Q = uniq('cond-idle');
  await createProject(cc, P);
  await createProject(cc, Q);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const a = await spawnConductor(cc, true);
  const aLabel = uniq('Alpha');
  await api(cc, 'PUT', `/api/sessions/${a.sessionId}/title`, { title: aLabel });
  const b = await spawnConductor(cc, false);
  await spawnWorker(cc, a.id, { project: P });
  const aq = await spawnWorker(cc, a.id, { project: Q });
  await api(cc, 'DELETE', `/api/instances/${aq.id}`);
  await gone(cc, aq.id);
  return { P, Q, a, b, aLabel };
}

parity('legacy-sidebar-lenses/R3', "conductor rows: titled bold and untitled muted italic, live and idle chips, block bars in each conductor's colour with the highlight past them, and the selected row and its strip entry bold and framed", async ({ page, cc, ui, uniq }) => {
  // Invariant: a titled label is at least 600 and an untitled one muted italic, live chips are solid and bright and idle ones dashed and muted, each block's bar is its conductor's colour, the row box starts past the bar and its content stays put when hovered or selected, and the selected conductor row and its strip entry read 700, framed and filled.
  test.setTimeout(180_000);
  const s = await seedPair(cc, uniq);
  await ui.open(page);
  let g0: { bar: string | null; barWidth: number; rowLeft: number; contentLeft: number };

  await test.step('labels and chips', async () => {
    const aRow = await ui.conductorRow(page, s.a.sessionId);
    await expect(aRow).toHaveCount(1);
    await expect.poll(async () => (await ui.conductorRowStyle(aRow)).text).toBe(s.aLabel);
    const aSt = await ui.conductorRowStyle(aRow);
    expect({ italic: aSt.italic, muted: aSt.muted }).toEqual({ italic: false, muted: false });
    expect(Number(aSt.weight)).toBeGreaterThanOrEqual(600);
    expect(Number(aSt.weight)).toBeLessThan(700);
    const bSt = await ui.conductorRowStyle(await ui.conductorRow(page, s.b.sessionId));
    expect({ italic: bSt.italic, muted: bSt.muted }).toEqual({ italic: true, muted: true });
    expect(Number(bSt.weight)).toBeLessThan(600);
    await expect.poll(() => ui.conductorChips(page, s.a.sessionId)).toEqual([
      { project: s.P, kind: 'live', dashed: false, muted: false },
      { project: s.Q, kind: 'idle', dashed: true, muted: true },
    ]);
  });

  await test.step('bars and the hovered highlight', async () => {
    const colA = await colourOf(page, s.a.sessionId);
    const colB = await colourOf(page, s.b.sessionId);
    g0 = await ui.conductorGeometry(page, s.a.sessionId);
    expect(g0.bar).toBe(colA);
    expect(g0.barWidth).toBeGreaterThan(0);
    expect(g0.rowLeft).toBeCloseTo(g0.barWidth, 1);
    expect((await ui.conductorGeometry(page, s.b.sessionId)).bar).toBe(colB);
    await (await ui.conductorRow(page, s.a.sessionId)).hover();
    const gh = await ui.conductorGeometry(page, s.a.sessionId);
    expect(gh.rowLeft).toBeCloseTo(gh.barWidth, 1);
    expect(gh.contentLeft).toBeCloseTo(g0.contentLeft, 1);
  });

  await test.step('selected', async () => {
    let entry = await ui.stripEntry(page, s.a.sessionId);
    await expect(entry).toHaveCount(1);
    const e0 = await ui.stripEntryStyle(entry);
    expect(e0.active).toBe(false);
    expect(e0.framed).toBe(false);
    expect(Number(e0.weight)).toBeLessThan(700);
    const r0 = await ui.conductorRowStyle(await ui.conductorRow(page, s.a.sessionId));
    expect(r0.active).toBe(false);
    expect(r0.framed).toBe(false);

    await ui.openConductor(page, s.a.sessionId);
    await expect(ui.sessionHeader(page).locator(`[title="session ${s.a.sessionId}"]`)).toBeVisible();
    // Re-acquiring the row re-opens the phone drawer; the pointer leaves so the fill read is the selected one, not the hovered one.
    const aRow = await ui.conductorRow(page, s.a.sessionId);
    await page.mouse.move(1, 1);
    await expect.poll(async () => (await ui.conductorRowStyle(aRow)).active).toBe(true);
    const r1 = await ui.conductorRowStyle(aRow);
    expect(r1.framed).toBe(true);
    expect(r1.fill).not.toBe(r0.fill);
    const g1 = await ui.conductorGeometry(page, s.a.sessionId);
    expect(g1.rowLeft).toBeCloseTo(g1.barWidth, 1);
    expect(g1.contentLeft).toBeCloseTo(g0.contentLeft, 1);

    entry = await ui.stripEntry(page, s.a.sessionId);
    await expect.poll(async () => (await ui.stripEntryStyle(entry)).active).toBe(true);
    const e1 = await ui.stripEntryStyle(entry);
    expect(e1.fill).not.toBe(e0.fill);

    expect.soft(r1.weight, 'selected conductor row label weight').toBe('700');
    expect.soft(e1.framed, 'selected strip entry framed').toBe(true);
    expect.soft(e1.weight, 'selected strip entry label weight').toBe('700');
  });
});

parity('sidebar-conductors/R2', "a conductor row's × shows on hover, and each row label keeps its floor while the ago label, ↑ and × keep their size inside the row", async ({ page, cc, ui, uniq }) => {
  // Invariant: an inactive conductor row's × is hidden until hover on a pointer device and shown on hover; the conductor title, a tree worker's label column and a session row's label grow from a 0 basis above a non-zero floor with their text keeping its height; ago, ↑ and × never shrink and stay inside the row, even beside an overflowing label.
  test.setTimeout(180_000);
  const P = uniq('rows');
  await createProject(cc, P);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const long = ' — a label long enough to overflow the sidebar row and truncate'.repeat(2);
  const a = await spawnConductor(cc, true);
  await api(cc, 'PUT', `/api/sessions/${a.sessionId}/title`, { title: uniq('Alpha') + long });
  const aw = await spawnWorker(cc, a.id, { project: P });
  const handRes = await api(cc, 'POST', '/api/instances', { project: P, mode: 'bypassPermissions', temp: true, ...liveModel(cc) });
  expect(handRes.status, `POST /api/instances (hand): ${JSON.stringify(handRes.body)}`).toBeLessThan(300);
  const hand = await idleInst(cc, (i) => i.id === handRes.body.id, 'hand-spawned session idle');
  await api(cc, 'PUT', `/api/sessions/${hand.sessionId}/title`, { title: uniq('hand') + long });
  const d = await spawnConductor(cc, false);
  await seedTranscript(cc, d.id, uniq('delta'));
  await expect.poll(async () => ((await api(cc, 'GET', '/api/projects/.conduct/sessions')).body as { sessionId: string }[]).some((r) => r.sessionId === d.sessionId)).toBe(true);
  await api(cc, 'DELETE', `/api/instances/${d.id}`);
  await gone(cc, d.id);
  await ui.open(page);

  await test.step('inactive row ×', async () => {
    await ui.openInactive(page);
    const row = await ui.conductorRow(page, d.sessionId);
    await expect(row).toHaveCount(1);
    const close = ui.sessionClose(row);
    await expect(close).toHaveCount(1);
    const op = () => close.evaluate((e) => getComputedStyle(e).opacity);
    // Drawer viewports are touch, where both UIs' (hover: none) rules may show the × unhovered: only the shown-after-hover half is common.
    if (desktop()) {
      await page.mouse.move(1, 1);
      await expect.poll(op).toBe('0');
    }
    await row.hover();
    await expect.poll(op).toBe('1');
  });

  await test.step('label floors', async () => {
    // Each layout is read right after its row is acquired: a lens switch unmounts the other list.
    const cL = await ui.rowLayout(await ui.conductorRow(page, a.sessionId));
    const wL = await ui.rowLayout(await ui.treeWorkerRow(page, a.sessionId, aw.sessionId));
    const hL = await ui.rowLayout(await ui.sessionRow(page, P, hand.sessionId));
    expect(cL.label.minWidth, 'conductor title floor').toBeGreaterThan(0);
    expect(cL.label.basis, 'conductor title basis').toBe(0);
    expect(cL.label.grow, 'conductor title grow').toBe('1');
    expect(cL.label.width, 'conductor title width').toBeGreaterThanOrEqual(cL.label.minWidth - 0.5);
    expect(cL.label.textHeight, 'conductor title text height').toBeGreaterThan(0);
    expect(wL.label.minWidth, 'tree worker label floor').toBeGreaterThan(0);
    expect(wL.label.basis, 'tree worker label basis').toBe(0);
    expect(wL.label.grow, 'tree worker label grow').toBe('1');
    expect(wL.label.width, 'tree worker label width').toBeGreaterThanOrEqual(wL.label.minWidth - 0.5);
    expect(wL.label.textHeight, 'tree worker label text height').toBeGreaterThan(0);
    expect(hL.label.minWidth, 'session label floor').toBeGreaterThan(0);
    expect(hL.label.basis, 'session label basis').toBe(0);
    expect(hL.label.grow, 'session label grow').toBe('1');
    expect(hL.label.width, 'session label width').toBeGreaterThanOrEqual(hL.label.minWidth - 0.5);
    expect(hL.label.textHeight, 'session label text height').toBeGreaterThan(0);
    expect(cL.label.truncated, 'fixture: the conductor title overflows').toBe(true);
    expect(hL.label.truncated, 'fixture: the session label overflows').toBe(true);
    const byPart = (l: typeof cL) => [...l.fixed].sort((x, y) => x.part.localeCompare(y.part));
    expect(byPart(cL)).toEqual([{ part: 'ago', shrink: '0', inside: true }, { part: 'promote', shrink: '0', inside: true }]);
    expect(byPart(wL)).toEqual([{ part: 'ago', shrink: '0', inside: true }, { part: 'promote', shrink: '0', inside: true }]);
    expect(byPart(hL)).toEqual([
      { part: 'ago', shrink: '0', inside: true },
      { part: 'close', shrink: '0', inside: true },
      { part: 'promote', shrink: '0', inside: true },
    ]);
  });
});
