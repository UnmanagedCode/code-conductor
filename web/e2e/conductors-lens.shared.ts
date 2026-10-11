// The Conductors lens under /next/: the expanded tree's actions and stage lines, the Inactive group, and ↑ / ×
// end to end on a real server. The bodies are shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { api, createProject, mcpCall } from './harness/api.ts';
import { expect, test, type Cc } from './harness/fixtures.ts';
import { seedTranscript } from './harness/transcript.ts';
import { archived, gone, insts, spawnConductor, spawnWorker } from './parity/fleet.ts';
import { next, nextSidebar } from './parity/ui.ts';

type Ctx = { page: Page; cc: Cc };
type Inst = { id: string; sessionId: string; status: string; temp?: boolean; playbook?: string | null; stage?: string | null };

const label = (s: string) => `e2e-cl-${s}-${test.info().project.name}`;
/** The tree's structural and close actions: none may appear in a conductor tree. */
const STRUCTURAL = ['New session', 'Delete project', 'New session in this worktree', 'Remove worktree', 'Stop session', 'Archive session (keeps history)'];

// Invariant: the expanded tree offers no structural or close action while commit history and review stay; ↑ sits on exactly
// the live temp conductor and worker rows of the lens, once each; a stage line shows exactly on a bound worker, matching /api/instances.
export async function treeFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(180_000);
  const P = label('tree');
  await createProject(cc, P);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const a = await spawnConductor(cc, true);
  const b = await spawnConductor(cc, false);
  const main = await spawnWorker(cc, a.id, { project: P });
  const inWt = await spawnWorker(cc, a.id, { project: P, createWorktree: true, name: label('wt') });
  const listed = JSON.parse((await mcpCall(cc, 'list_playbooks', {}, a.id)).content[0].text);
  type Pb = { id: string; entryStages?: string[]; spawnableStages?: string[] };
  const pb = ((listed.playbooks ?? []) as Pb[]).find((p) => (p.entryStages ?? []).some((s) => (p.spawnableStages ?? []).includes(s)));
  expect(pb, 'fixture: list_playbooks offers a playbook with a spawnable entry stage').toBeTruthy();
  const stage = pb!.entryStages!.find((s) => pb!.spawnableStages!.includes(s));
  // No explicit mode: a stage may pin one, and a conflicting value is refused.
  const bound = await spawnWorker(cc, a.id, { project: P, playbook: pb!.id, stage, mode: undefined });
  const boundInst = ((await insts(cc)) as Inst[]).find((i) => i.sessionId === bound.sessionId)!;
  const expectedStage = [boundInst.playbook, boundInst.stage].filter(Boolean).join(' · ');
  expect(expectedStage, 'fixture: the bound worker reports its binding').not.toBe('');

  await next.open(page);
  const sb = nextSidebar(page);
  await next.lens(page, 'conductors');
  await expect(sb.locator(`[data-conductor="${a.sessionId}"]`)).toHaveCount(1);
  await expect(sb.locator(`[data-conductor="${b.sessionId}"]`)).toHaveCount(1);
  for (const w of [main, inWt, bound]) await expect(await next.treeWorkerRow(page, a.sessionId, w.sessionId)).toHaveCount(1);

  await test.step('the tree is read-only', async () => {
    const tree = sb.locator(`[data-conductor="${a.sessionId}"] [data-conductor-tree]`);
    const actions = await tree.locator('button[aria-label]').evaluateAll((bs) => [...new Set(bs.map((x) => x.getAttribute('aria-label')))]);
    for (const l of STRUCTURAL) expect(actions, l).not.toContain(l);
    expect(actions).toContain('Commit history');
    expect(actions).toContain('Review changes');
    await next.lens(page, 'projects');
    const row = await next.projectRow(page, P);
    await expect(row.getByRole('button', { name: 'New session' }), 'positive control: the Projects lens offers it').toHaveCount(1);
    await next.lens(page, 'conductors');
    await expect(await next.treeWorkerRow(page, a.sessionId, main.sessionId)).toHaveCount(1);
  });

  await test.step('↑ on exactly the live temp rows', async () => {
    const all = (await insts(cc)) as Inst[];
    const liveTemp = new Set(all.filter((i) => i.temp === true && i.status !== 'exited' && i.status !== 'crashed').map((i) => i.sessionId));
    const seen = await sb.locator('[data-conductor-list]').evaluate((list) => {
      const up = 'button[aria-label="Make persistent"]';
      const rows = [
        ...[...list.querySelectorAll<HTMLElement>('[data-conductor-tree] [data-session-row]')]
          .map((r) => ({ kind: 'worker', sid: r.dataset.sessionRow!, n: r.querySelectorAll(up).length })),
        ...[...list.querySelectorAll<HTMLElement>('[data-conductor]')]
          .map((blk) => ({ kind: 'conductor', sid: blk.dataset.conductor!, n: blk.querySelector(':scope > [role="button"]')!.querySelectorAll(up).length })),
      ];
      return { rows, total: list.querySelectorAll(up).length };
    });
    const ctx = JSON.stringify({ seen, liveTemp: [...liveTemp] });
    expect(seen.rows.some((r) => r.kind === 'worker' && liveTemp.has(r.sid)), `fixture: a live temp worker row: ${ctx}`).toBe(true);
    expect(seen.rows.some((r) => r.kind === 'conductor' && r.sid === b.sessionId), `fixture: a non-temp conductor row: ${ctx}`).toBe(true);
    for (const r of seen.rows) expect(r.n, `${r.kind} ${r.sid}: ${ctx}`).toBe(liveTemp.has(r.sid) ? 1 : 0);
    expect(seen.total, `no ↑ outside a conductor or worker row: ${ctx}`).toBe(seen.rows.reduce((n, r) => n + r.n, 0));
  });

  await test.step('a stage line only when bound', async () => {
    const stageOf = async (sid: string) => (await next.treeWorkerRow(page, a.sessionId, sid)).locator('[data-stage]');
    await expect(await stageOf(bound.sessionId)).toHaveText(expectedStage);
    await expect(await stageOf(main.sessionId)).toHaveCount(0);
    await expect(await stageOf(inWt.sessionId)).toHaveCount(0);
  });
}

// Invariant: a killed persistent conductor moves under a collapsed Inactive (1); a killed temp conductor is archived and is
// in no group, before and after a reload; ↑ makes a live temp conductor persistent on the same row; × archives an inactive
// conductor, and the group goes with its last member.
export async function inactiveFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(180_000);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const a = await spawnConductor(cc, true);
  await api(cc, 'PUT', `/api/sessions/${a.sessionId}/title`, { title: label('alpha') });
  const b = await spawnConductor(cc, false);
  await seedTranscript(cc, b.id, label('bravo'));
  const c = await spawnConductor(cc, true);
  await seedTranscript(cc, c.id, label('charlie'));
  await expect.poll(async () => ((await api<{ sessionId: string }[]>(cc, 'GET', '/api/projects/.conduct/sessions')).body).some((r) => r.sessionId === b.sessionId),
    { message: 'fixture: B is listed on disk' }).toBe(true);

  await next.open(page);
  const sb = nextSidebar(page);
  await next.lens(page, 'conductors');
  await expect(sb.locator(`[data-conductor="${a.sessionId}"]`)).toHaveCount(1);
  await expect(sb.locator('[data-conductors-inactive]'), 'fixture: nothing inactive yet').toHaveCount(0);
  const block = (sid: string) => sb.locator(`[data-conductor="${sid}"]`);
  const toggle = sb.locator('[data-conductors-inactive] > button[aria-expanded]');

  await test.step('a killed conductor moves under a collapsed Inactive (1)', async () => {
    await api(cc, 'DELETE', `/api/instances/${b.id}`);
    await gone(cc, b.id);
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveText(/\(1\)/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(block(b.sessionId)).toHaveCount(0);
    await next.openInactive(page);
    await expect(sb.locator(`[data-conductors-inactive] [data-conductor="${b.sessionId}"]`)).toHaveCount(1);
  });

  await test.step('an archived temp conductor is in no group', async () => {
    await api(cc, 'DELETE', `/api/instances/${c.id}`);
    await gone(cc, c.id);
    await archived(cc, '.conduct', c.sessionId);
    const plain = ((await api<{ sessionId: string }[]>(cc, 'GET', '/api/projects/.conduct/sessions')).body).some((r) => r.sessionId === c.sessionId);
    expect(plain, 'C in the plain .conduct listing').toBe(false);
    await expect(block(c.sessionId)).toHaveCount(0);
    await expect(toggle).toHaveText(/\(1\)/);
    await page.reload();
    await next.openInactive(page);
    // B is a disk row only: its inactive row proves the listing landed.
    await expect(sb.locator(`[data-conductors-inactive] [data-conductor="${b.sessionId}"]`)).toHaveCount(1);
    await expect(toggle).toHaveText(/\(1\)/);
    await expect(block(c.sessionId)).toHaveCount(0);
  });

  await test.step('↑ makes a live temp conductor persistent on the same row', async () => {
    const row = await next.conductorRow(page, a.sessionId);
    await row.evaluate((e) => { (e as HTMLElement & { __kept?: boolean }).__kept = true; });
    await row.getByRole('button', { name: 'Make persistent' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Make persistent' }).click();
    await expect(row.getByRole('button', { name: 'Make persistent' })).toHaveCount(0);
    expect(await row.evaluate((e) => (e as HTMLElement & { __kept?: boolean }).__kept === true), 'the same row node').toBe(true);
    await expect.poll(async () => ((await insts(cc)) as Inst[]).find((i) => i.id === a.id)?.temp).toBe(false);
    await expect(sb.locator(`[data-conductors-inactive] [data-conductor="${a.sessionId}"]`)).toHaveCount(0);
  });

  await test.step('× archives an inactive conductor, and the empty group goes', async () => {
    await next.openInactive(page);
    const row = await next.conductorRow(page, b.sessionId);
    await row.hover();
    await row.getByRole('button', { name: 'Archive session (keeps history)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
    await archived(cc, '.conduct', b.sessionId);
    await expect(block(b.sessionId)).toHaveCount(0);
    await expect(sb.locator('[data-conductors-inactive]')).toHaveCount(0);
  });
}
