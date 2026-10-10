// The old UI's awaiting-wake sidebar dot, in a real browser.
//
// `public/` gets no typecheck and the node:test suite never loads the render
// path, so a browser is the ONLY gate on the accent idle dot. Each dot box
// asserts the class AND the computed background colour: the class alone passes
// under a CSS rename, the colour alone under a JS rename.
//
// `awaitingWake` is CALLER-side (`InstanceManager.list()` ← `isIdleCaller`), so
// the dot says "idle because I am waiting on a worker" rather than "idle because
// I am done" — and it must STAY lit across a heartbeat, because a heartbeat
// reports without consuming the wake. That step is the one most likely to
// regress silently.
//
// One scenario drives BOTH sessions: the two WORKER-* prompts are long turns
// (delay_ms spaces every event), and the unfiltered turns behind them are what
// the conductor answers each wake stub with, so it returns to idle in ms.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api, createProject, mcpCall } from '../harness/api.ts';
import { FIXTURES } from '../harness/boot.ts';

// Long enough that the conductor is back at idle well before the next ping, and
// short enough that one lands inside the worker's turn.
const HEARTBEAT_MS = 3000;

test.use({
  ccOptions: { server: 'awaiting-wake-dot', scenario: path.join(FIXTURES, 'scenario-awaiting-wake.json'), env: { ORCH_SUBSCRIBE_TIMEOUT_MS: String(HEARTBEAT_MS) } },
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});

type Inst = { id: string; sessionId: string; status: string };
type Dot = { cls: string; title: string; bg: string; accent: string };
type Holder = HTMLElement & { _holder?: { session?: { instanceId?: string } } };

/** Polls `fn` until it returns a truthy value and returns that value. */
async function until<T>(fn: () => Promise<T | false | null | undefined>, timeout = 20_000, what = 'condition'): Promise<T> {
  let v: T | false | null | undefined;
  await expect(async () => {
    v = await fn();
    expect(v, what).toBeTruthy();
  }).toPass({ timeout, intervals: [100] });
  return v as T;
}

const insts = async (cc: Cc): Promise<Inst[]> => (await api<Inst[]>(cc, 'GET', '/api/instances')).body;
const statusOf = async (cc: Cc, pred: (i: Inst) => boolean) => (await insts(cc)).find(pred)?.status;

const userEchoes = async (cc: Cc, condId: string, needle: string): Promise<number> => {
  const e = await api(cc, 'GET', `/api/instances/${condId}/events`);
  return ((e.body.events ?? []) as { kind: string; text?: unknown }[])
    .filter((x) => x.kind === 'user_echo' && typeof x.text === 'string' && x.text.includes(needle)).length;
};

// Rows carry their session on the <li>'s `_holder` (public/sidebar.js), which
// is how a check addresses the conductor's row rather than guessing from its text.
const dotOf = (page: Page, instanceId: string) => page.evaluate((id): Dot | null => {
  for (const row of document.querySelectorAll('.session-row')) {
    const h = (row.parentElement as Holder | null)?._holder;
    if (h?.session?.instanceId !== id) continue;
    const dot = row.querySelector<HTMLElement>('.dot');
    if (dot) return {
      cls: dot.className, title: dot.title,
      bg: getComputedStyle(dot).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
  }
  return null;
}, instanceId);

test('the conductor dot lights while its worker is mid-turn, stays lit across a heartbeat, and clears at turn_end', async ({ page, cc }) => {
  test.setTimeout(180_000);

  await createProject(cc, 'uipass');
  const c = await api(cc, 'POST', '/api/instances', { project: 'uipass', mode: 'bypassPermissions' });
  expect(c.status, JSON.stringify(c.body)).toBeLessThan(300);
  const condId: string = c.body.id;
  await until(async () => (await statusOf(cc, (i) => i.id === condId)) === 'idle', 20_000, 'conductor idle');

  // Spawn the worker THROUGH the conductor, so callerInstanceId is set and the
  // sidebar groups it as conducted (the real conduct-mode shape).
  const spawn = JSON.parse((await mcpCall(cc, 'spawn_instance', { project: 'uipass', mode: 'bypassPermissions' }, condId)).content[0].text);
  const workerSid: string = spawn.sessionId;
  await until(async () => (await statusOf(cc, (i) => i.sessionId === workerSid)) === 'idle', 20_000, 'worker idle');
  const workerId = (await insts(cc)).find((i) => i.sessionId === workerSid)!.id;

  await page.goto('/legacy/', { waitUntil: 'networkidle' });
  await until(() => dotOf(page, condId), 20_000, 'conductor row dot');

  const before = await test.step('baseline: nothing armed, plain idle dot', async () => {
    const d = (await dotOf(page, condId))!;
    expect(d.cls).toBe('dot idle');
    expect(d.title).toBe('idle');
    return d;
  });

  // Drive the worker mid-turn FROM the conductor.
  await mcpCall(cc, 'send_prompt', { sessionId: workerSid, text: 'WORKER-GO' }, condId);
  await until(async () => (await statusOf(cc, (i) => i.id === workerId)) === 'turn', 20_000, 'worker in turn');

  const mid = await test.step('worker mid-turn: conductor row is the accent idle dot with the waiting tooltip', async () => {
    const d = await until(async () => { const x = await dotOf(page, condId); return x && x.cls.includes('awaiting') ? x : false; }, 8000, 'awaiting dot');
    expect(d.cls).toBe('dot idle awaiting');
    expect(d.title).toBe('idle — waiting on a worker');
    expect(d.bg, `plain idle was ${before.bg}, --accent ${d.accent}`).not.toBe(before.bg);
    return d;
  });

  await test.step('across a heartbeat, the dot stays accent', async () => {
    const beatCount = () => userEchoes(cc, condId, 'did NOT finish');
    await until(async () => (await beatCount()) >= 1, HEARTBEAT_MS * 3, 'a heartbeat');
    // The heartbeat WAKES the conductor, so it takes a turn of its own; sample
    // once it is back at idle, with its worker still mid-turn.
    await until(async () => (await statusOf(cc, (i) => i.id === condId)) === 'idle', 20_000, 'conductor back at idle');
    const beats = await beatCount();
    const workerStill = await statusOf(cc, (i) => i.id === workerId);
    const afterBeat = (await dotOf(page, condId))!;
    expect(beats).toBeGreaterThanOrEqual(1);
    expect(workerStill, 'worker status while sampling').toBe('turn');
    expect(afterBeat.cls).toBe('dot idle awaiting');
    expect(afterBeat.bg).toBe(mid.bg);
  });

  // Wait for the worker's turn to end and the completion wake to land.
  await until(async () => (await statusOf(cc, (i) => i.id === workerId)) === 'idle', 20_000, 'worker idle after its turn');
  await until(async () => (await userEchoes(cc, condId, 'finished its turn')) > 0, 20_000, 'completion wake');

  await test.step('after turn_end the dot drops to plain idle', async () => {
    await until(async () => (await statusOf(cc, (i) => i.id === condId)) === 'idle', 20_000, 'conductor idle');
    const done = await until(async () => { const x = await dotOf(page, condId); return x && !x.cls.includes('awaiting') ? x : false; }, 10_000, 'plain dot');
    expect(done.cls).toBe('dot idle');
    expect(done.title).toBe('idle');
    expect(done.bg).toBe(before.bg);
  });

  await test.step('the wake-callback bubble is folded and collapsible', async () => {
    await page.evaluate((id) => {
      for (const row of document.querySelectorAll<HTMLElement>('.session-row')) {
        if ((row.parentElement as Holder | null)?._holder?.session?.instanceId === id) { row.click(); return; }
      }
    }, condId);
    const bubble = await until(() => page.evaluate(() => {
      for (const b of document.querySelectorAll('.wake-callback')) {
        const t = b.textContent || '';
        if (!t.includes('finished its turn')) continue;
        return { cls: b.className, hasDetails: !!b.querySelector('details'), badge: t.includes('\u{1F514}') };
      }
      return null;
    }), 25_000, 'wake-callback bubble');
    expect(bubble.hasDetails, `class="${bubble.cls}"`).toBe(true);
    expect(bubble.badge, `class="${bubble.cls}"`).toBe(true);
    await test.info().attach('awaiting-wake-conductor', { body: await page.screenshot(), contentType: 'image/png' });
  });

  await test.step('list_sessions renders awaiting-wake yes and no', async () => {
    // Re-arm by driving the worker again, then read the conductor-facing text.
    await mcpCall(cc, 'send_prompt', { sessionId: workerSid, text: 'WORKER-AGAIN' }, condId);
    await until(async () => (await statusOf(cc, (i) => i.id === workerId)) === 'turn', 20_000, 'worker in turn again');
    const listed: string = (await mcpCall(cc, 'list_sessions', { project: 'uipass' }, condId)).content[0].text;
    expect(listed).toMatch(/awaiting-wake yes/);
    expect(listed).toMatch(/awaiting-wake no/);
  });
});
