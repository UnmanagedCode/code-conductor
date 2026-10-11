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

parity('legacy-sidebar-lenses/R3', "conductor rows: titled and untitled labels, live and idle chips, block bars in each conductor's colour, and the selected row and its strip entry marked and filled", async ({ page, cc, ui, uniq }) => {
  // Invariant: a titled conductor row shows its title, live and idle chips list their projects in order with their kind, each block's bar is its own conductor's colour, and selecting a conductor marks its row and its strip entry active with a fill an unselected one lacks, the strip entry keeping the conductor's colour.
  test.setTimeout(180_000);
  const s = await seedPair(cc, uniq);
  await ui.open(page);

  await test.step('labels and chips', async () => {
    const aRow = await ui.conductorRow(page, s.a.sessionId);
    await expect(aRow).toHaveCount(1);
    await expect(aRow).toContainText(s.aLabel);
    await expect.poll(() => ui.conductorChips(page, s.a.sessionId)).toEqual([
      { project: s.P, kind: 'live' },
      { project: s.Q, kind: 'idle' },
    ]);
  });

  const colA = await colourOf(page, s.a.sessionId);
  const colB = await colourOf(page, s.b.sessionId);
  await test.step('bars', async () => {
    expect(await ui.conductorBar(page, s.a.sessionId)).toBe(colA);
    expect(await ui.conductorBar(page, s.b.sessionId)).toBe(colB);
  });

  await test.step('selected', async () => {
    let entry = await ui.stripEntry(page, s.a.sessionId);
    await expect(entry).toHaveCount(1);
    const e0 = await ui.stripEntryStyle(entry);
    expect(e0.active).toBe(false);
    const r0 = await ui.conductorRowStyle(await ui.conductorRow(page, s.a.sessionId));
    expect(r0.active).toBe(false);

    await ui.openConductor(page, s.a.sessionId);
    await expect(ui.sessionHeader(page).locator(`[title="session ${s.a.sessionId}"]`)).toBeVisible();
    // Re-acquiring the row re-opens the phone drawer; the pointer leaves so the fill read is the selected one, not the hovered one.
    const aRow = await ui.conductorRow(page, s.a.sessionId);
    await page.mouse.move(1, 1);
    await expect.poll(async () => (await ui.conductorRowStyle(aRow)).active).toBe(true);
    const r1 = await ui.conductorRowStyle(aRow);
    expect(r1.fill).not.toBe(r0.fill);
    // The other conductor's row is no more selected than before.
    expect((await ui.conductorRowStyle(await ui.conductorRow(page, s.b.sessionId))).active).toBe(false);

    entry = await ui.stripEntry(page, s.a.sessionId);
    await expect.poll(async () => (await ui.stripEntryStyle(entry)).active).toBe(true);
    const e1 = await ui.stripEntryStyle(entry);
    expect(e1.fill).not.toBe(e0.fill);
    expect(e1.colour).toBe(colA);
  });
});

parity('sidebar-conductors/R2', "a conductor row's × shows on hover, and each row label stays readable and truncates while the ago label, ↑ and × stay inside the row", async ({ page, cc, ui, uniq }) => {
  // Invariant: an inactive conductor row's × is hidden until hover on a pointer device and shown on hover; the conductor title, a tree worker's label column and a session row's label keep a non-zero width and text height and truncate when long; ago, ↑ and × stay inside the row, even beside an overflowing label.
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
    if (desktop()) {
      await page.mouse.move(1, 1);
      await expect.poll(op).toBe('0');
      await row.hover();
      await expect.poll(op).toBe('1');
    } else {
      // Drawer viewports are touch: (hover: none) shows the × with no hover at all, read before any hover.
      await expect.poll(op, 'touch: the × shows unhovered').toBe('1');
    }
  });

  await test.step('label floors', async () => {
    // Each layout is read right after its row is acquired: a lens switch unmounts the other list.
    const cL = await ui.rowLayout(await ui.conductorRow(page, a.sessionId));
    const wL = await ui.rowLayout(await ui.treeWorkerRow(page, a.sessionId, aw.sessionId));
    const hL = await ui.rowLayout(await ui.sessionRow(page, P, hand.sessionId));
    for (const [name, l] of [['conductor title', cL], ['tree worker label', wL], ['session label', hL]] as const) {
      expect(l.label.width, `${name} width`).toBeGreaterThan(0);
      expect(l.label.textHeight, `${name} text height`).toBeGreaterThan(0);
    }
    expect(cL.label.truncated, 'fixture: the conductor title overflows').toBe(true);
    expect(hL.label.truncated, 'fixture: the session label overflows').toBe(true);
    const byPart = (l: typeof cL) => l.fixed.map((f) => ({ part: f.part, inside: f.inside })).sort((x, y) => x.part.localeCompare(y.part));
    expect(byPart(cL)).toEqual([{ part: 'ago', inside: true }, { part: 'promote', inside: true }]);
    expect(byPart(wL)).toEqual([{ part: 'ago', inside: true }, { part: 'promote', inside: true }]);
    expect(byPart(hL)).toEqual([
      { part: 'ago', inside: true },
      { part: 'close', inside: true },
      { part: 'promote', inside: true },
    ]);
  });
});
