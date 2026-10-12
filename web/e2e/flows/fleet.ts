// The sidebar flow files' shared fleet helpers: spawning conductors and their workers, waiting on instances, and conductor colours as the page resolves them.
import type { Page } from '@playwright/test';
import { api, LIVE_WORKER_MODEL, mcpCall } from '../harness/api.ts';
import { expect, type Cc } from '../harness/fixtures.ts';

export type FleetInst = { id: string; sessionId: string; status: string; temp?: boolean; ownerSessionId?: string | null };

export const insts = async (cc: Cc): Promise<FleetInst[]> => (await api<FleetInst[]>(cc, 'GET', '/api/instances')).body;
export const liveModel = (cc: Cc) => (cc.engine === 'live' ? { model: LIVE_WORKER_MODEL } : {});

/** Waits until the instance `pred` matches is idle with a session id, and returns it. */
export async function idleInst(cc: Cc, pred: (i: FleetInst) => boolean, what: string): Promise<FleetInst> {
  let found: FleetInst | undefined;
  await expect.poll(async () => {
    found = (await insts(cc)).find(pred);
    return found?.status === 'idle' && !!found.sessionId;
  }, { message: what, timeout: 20_000 }).toBe(true);
  return found!;
}

export async function spawnConductor(cc: Cc, temp: boolean): Promise<FleetInst> {
  const r = await api(cc, 'POST', '/api/instances', {
    project: '.conduct', mode: 'bypassPermissions', temp, playbookEnforcement: 'warn', ...liveModel(cc),
  });
  expect(r.status, `POST /api/instances (.conduct): ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return idleInst(cc, (i) => i.id === r.body.id, `conductor ${r.body.id} idle`);
}

/** Spawns a worker through `spawn_instance` as the conductor whose instance id is `caller`. */
export async function spawnWorker(cc: Cc, caller: string, args: Record<string, unknown>): Promise<FleetInst> {
  const r = await mcpCall(cc, 'spawn_instance', { mode: 'bypassPermissions', ...liveModel(cc), ...args }, caller);
  if (r.isError) throw new Error(`spawn_instance refused: ${r.content?.[0]?.text}`);
  const { sessionId } = JSON.parse(r.content[0].text);
  return idleInst(cc, (i) => i.sessionId === sessionId, `worker ${sessionId} idle`);
}

/** A conductor's colour resolved the way the page does, as a computed rgb(). */
export const colourOf = (page: Page, sid: string) => page.evaluate(async ([s, mod]) => {
  const { conductorColor } = await import(mod);
  const probe = document.createElement('i');
  probe.style.color = conductorColor(s);
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, [sid, '/conductorColor.js'] as const);

export const gone = (cc: Cc, id: string) =>
  expect.poll(async () => (await insts(cc)).some((i) => i.id === id), { message: `instance ${id} gone` }).toBe(false);

export const archived = (cc: Cc, project: string, sid: string) =>
  expect.poll(async () => ((await api<{ sessionId: string; archived?: boolean }[]>(cc, 'GET', `/api/projects/${project}/sessions?includeArchived=1`)).body ?? [])
    .some((r) => r.sessionId === sid && r.archived === true), { message: `${sid} archived` }).toBe(true);
