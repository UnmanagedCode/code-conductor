// The awaiting-wake dot: a scenario of two long WORKER-* turns and a short subscribe timeout so a heartbeat lands mid-turn.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, createProject, mcpCall } from '../harness/api.ts';
import { FIXTURES } from '../harness/boot.ts';
import { expect, test, type Cc } from './test.ts';
import { idleInst, insts, liveModel } from './fleet.ts';
import type { Ui } from './ui.ts';

// Long enough that the caller is back at idle well before the next ping, and short enough that one lands inside the worker's turn.
const HEARTBEAT_MS = 3000;

test.use({ ccOptions: { server: 'sidebar-wake', scenario: path.join(FIXTURES, 'scenario-awaiting-wake.json'), env: { ORCH_SUBSCRIBE_TIMEOUT_MS: String(HEARTBEAT_MS) } } });

const statusOf = async (cc: Cc, id: string) => (await insts(cc)).find((i) => i.id === id)?.status;

const userEchoes = async (cc: Cc, id: string, needle: string): Promise<number> => {
  const e = await api(cc, 'GET', `/api/instances/${id}/events`);
  return ((e.body.events ?? []) as { kind: string; text?: unknown }[])
    .filter((x) => x.kind === 'user_echo' && typeof x.text === 'string' && x.text.includes(needle)).length;
};

/** The session row's dot, re-acquiring the row on every read. */
const dot = async (page: Page, ui: Ui, project: string, sid: string) => ui.rowDot(await ui.sessionRow(page, project, sid));

test("a session's dot lights while its worker is mid-turn, stays lit across a heartbeat, and clears at turn_end", async ({ page, cc, ui, uniq }) => {
  // Invariant: the caller's dot reads waiting-on-a-worker (its title) while its worker is mid-turn, keeps it across a heartbeat, and returns to plain idle at turn_end.
  test.setTimeout(180_000);
  const P = uniq('wake');
  await createProject(cc, P);
  const c = await api(cc, 'POST', '/api/instances', { project: P, mode: 'bypassPermissions', ...liveModel(cc) });
  expect(c.status, `POST /api/instances (caller): ${JSON.stringify(c.body)}`).toBeLessThan(300);
  const caller = await idleInst(cc, (i) => i.id === c.body.id, 'caller idle');
  // Spawned THROUGH the caller, so the worker's wakes go to it.
  const r = await mcpCall(cc, 'spawn_instance', { project: P, mode: 'bypassPermissions', ...liveModel(cc) }, caller.id);
  if (r.isError) throw new Error(`spawn_instance refused: ${r.content?.[0]?.text}`);
  const { sessionId: workerSid } = JSON.parse(r.content[0].text);
  const worker = await idleInst(cc, (i) => i.sessionId === workerSid, 'worker idle');
  await ui.open(page);
  await expect(await ui.sessionRow(page, P, caller.sessionId)).toHaveCount(1);

  await test.step('baseline: a plain idle dot', async () => {
    await expect.poll(async () => (await dot(page, ui, P, caller.sessionId)).title).toBe('idle');
  });

  await test.step('worker mid-turn: the waiting-on-a-worker dot', async () => {
    await mcpCall(cc, 'send_prompt', { sessionId: worker.sessionId, text: 'WORKER-GO' }, caller.id);
    await expect.poll(() => statusOf(cc, worker.id), { message: 'worker in turn' }).toBe('turn');
    await expect.poll(async () => (await dot(page, ui, P, caller.sessionId)).title).toBe('idle — waiting on a worker');
  });

  await test.step('across a heartbeat, the dot stays lit', async () => {
    await expect.poll(() => userEchoes(cc, caller.id, 'did NOT finish'), { message: 'a heartbeat', timeout: HEARTBEAT_MS * 3 }).toBeGreaterThanOrEqual(1);
    // The heartbeat wakes the caller into a turn of its own; sample once it is back at idle, with its worker still mid-turn.
    await expect.poll(() => statusOf(cc, caller.id), { message: 'caller back at idle' }).toBe('idle');
    // The sidebar may still show the heartbeat's turn: wait for the dot to leave it before the read.
    await expect.poll(async () => (await dot(page, ui, P, caller.sessionId)).title, { message: 'dot out of the heartbeat turn' }).not.toBe('running');
    expect(await statusOf(cc, worker.id), 'fixture: worker still mid-turn').toBe('turn');
    expect((await dot(page, ui, P, caller.sessionId)).title).toBe('idle — waiting on a worker');
  });

  await test.step('after turn_end the dot drops to plain idle', async () => {
    await expect.poll(() => statusOf(cc, worker.id), { message: 'worker idle after its turn', timeout: 20_000 }).toBe('idle');
    await expect.poll(() => userEchoes(cc, caller.id, 'finished its turn'), { message: 'completion wake', timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => statusOf(cc, caller.id), { message: 'caller idle' }).toBe('idle');
    await expect.poll(async () => (await dot(page, ui, P, caller.sessionId)).title).toBe('idle');
  });
});
