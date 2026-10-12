// The needs-you strip on a real server: the group real sessions land in as they run, wait on a worker
// and ask; opening an asking session and replying; resumes onto ask transcripts; both lenses; the × and the drawer;
// and an armed entry's fit. The bodies are shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { api, createProject, mcpCall } from './harness/api.ts';
import { expect, test, type Cc } from './harness/fixtures.ts';
import { appendTranscriptRecord } from './harness/transcript.ts';
import { gone, idleInst, insts, liveModel, spawnConductor, spawnWorker, type FleetInst } from './flows/fleet.ts';
import { next, nextSidebar } from './flows/ui.ts';

type Ctx = { page: Page; cc: Cc };
type Inst = FleetInst & { awaitingUser?: string | null; awaitingUserSource?: string | null; awaitingWake?: boolean };
/** A strip entry as the page renders it: its visible text, accessible name, selection, and its dot's state and needs-you mark. */
type Entry = { sid: string; text: string; name: string; active: boolean; dot: string | null; needsYou: boolean };
type Strip = Record<string, Entry[]>;

const POLL = [100];
const label = (s: string) => `e2e-strip-${s}-${test.info().project.name}`;
const drawer = () => test.info().project.name !== 'desktop';
const byId = async (cc: Cc, id: string) => ((await insts(cc)) as Inst[]).find((i) => i.id === id);
const until = (cc: Cc, id: string, what: string, pred: (i: Inst) => boolean, timeout = 30_000) =>
  expect.poll(async () => { const i = await byId(cc, id); return !!i && pred(i); }, { message: what, timeout, intervals: POLL }).toBe(true);

/** The visible sidebar's strip by group, or null while it renders none. Opens the phone drawer first. */
async function readStrip(page: Page): Promise<Strip | null> {
  await next.openSidebar(page);
  return nextSidebar(page).evaluate((root) => {
    const strip = root.querySelector('[data-strip]');
    if (!strip) return null;
    const out: Strip = {};
    for (const g of strip.querySelectorAll('[data-strip-group]')) {
      out[g.getAttribute('data-strip-group')!] = [...g.querySelectorAll('[data-strip-entry]')].map((li) => {
        const b = li.querySelector(':scope > button') as HTMLElement;
        const d = b.querySelector('[data-dot]') as HTMLElement;
        return {
          sid: li.getAttribute('data-strip-entry')!, text: b.textContent ?? '', name: b.getAttribute('aria-label') ?? '',
          active: b.dataset.active === 'true', dot: d.dataset.dot ?? null, needsYou: d.dataset.needsYou === 'true',
        };
      });
    }
    return out;
  });
}
const groupsOf = (s: Strip | null, sid: string) => Object.keys(s ?? {}).filter((g) => s![g].some((e) => e.sid === sid));
const entryIn = (s: Strip | null, group: string, sid: string) => s?.[group]?.find((e) => e.sid === sid) ?? null;
/** What an entry's accessible name says beyond its visible label: its reason. */
const reasonOf = (e: Entry) => e.name.slice(e.text.length);

// Invariant: real sessions land in exactly one group as they run (a conductor's turn and its wait on a worker are Running,
// a hand-spawned turn is in no group, idle is Finished); a text ask, and a resume onto a plan or question transcript, put a
// session in Waiting, marked as needing you; a waiting conductor stays Waiting while on a worker and through the wake turn
// its worker's callback starts; opening it from the strip and replying from the composer clears the ask; the three asks
// read distinctly and no entry shows state text; the Projects lens shows the same strip; conducted workers are never listed.
export async function askFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(300_000);
  const P = label('ask');
  await createProject(cc, P);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  await next.open(page);
  const workers: string[] = [];
  const listed: string[] = [];
  /** Polls the strip until `ok` holds, noting any conducted worker a sample lists. */
  const sample = async (what: string, ok: (s: Strip | null) => boolean, timeout = 20_000): Promise<Strip | null> => {
    const seen: { s: Strip | null } = { s: null };
    await expect.poll(async () => {
      seen.s = await readStrip(page);
      listed.push(...workers.filter((w) => groupsOf(seen.s, w).length > 0));
      return ok(seen.s);
    }, { message: what, timeout, intervals: POLL }).toBe(true);
    return seen.s;
  };
  const only = (s: Strip | null, sid: string, group: string) => groupsOf(s, sid).join() === group;

  const D = await spawnConductor(cc, false);
  const hr = await api(cc, 'POST', '/api/instances', { project: P, mode: 'bypassPermissions', ...liveModel(cc) });
  expect(hr.status, `POST /api/instances (hand): ${JSON.stringify(hr.body)}`).toBeLessThan(300);
  const H = await idleInst(cc, (i) => i.id === hr.body.id, 'hand-spawned session idle');

  await test.step('an idle conductor and an idle hand-spawned session are Finished', async () => {
    const s = await sample('D and H Finished', (x) => only(x, D.sessionId, 'finished') && only(x, H.sessionId, 'finished'));
    expect(entryIn(s, 'finished', D.sessionId)!.needsYou).toBe(false);
    expect(entryIn(s, 'finished', H.sessionId)!.needsYou).toBe(false);
  });

  let working = '';
  await test.step('a conductor in a turn is Running; a hand-spawned session in a turn is in no group', async () => {
    await mcpCall(cc, 'send_prompt', { sessionId: D.sessionId, text: 'SLOW' });
    await mcpCall(cc, 'send_prompt', { sessionId: H.sessionId, text: 'SLOW' });
    await until(cc, D.id, 'D in a turn', (i) => i.status === 'turn');
    await until(cc, H.id, 'H in a turn', (i) => i.status === 'turn');
    const s = await sample('D Running, H in no group', (x) => only(x, D.sessionId, 'running') && groupsOf(x, H.sessionId).length === 0);
    const d = entryIn(s, 'running', D.sessionId)!;
    expect(d.dot).toBe('turn');
    working = reasonOf(d);
    await until(cc, D.id, 'D idle', (i) => i.status === 'idle');
    await until(cc, H.id, 'H idle', (i) => i.status === 'idle');
  });

  await test.step('a conductor idle on its worker is Running and says so; the worker is not listed', async () => {
    const Wd = await spawnWorker(cc, D.id, { project: P });
    workers.push(Wd.sessionId);
    await mcpCall(cc, 'send_prompt', { sessionId: Wd.sessionId, text: 'WORKER-GO' }, D.id);
    await until(cc, Wd.id, 'Wd in a turn', (i) => i.status === 'turn');
    await until(cc, D.id, 'D idle on its worker', (i) => i.status === 'idle' && !!i.awaitingWake);
    const s = await sample('D Running with an idle dot', (x) => only(x, D.sessionId, 'running') && entryIn(x, 'running', D.sessionId)!.dot === 'idle');
    expect(reasonOf(entryIn(s, 'running', D.sessionId)!), 'waiting on a worker reads differently from working').not.toBe(working);
    expect(groupsOf(s, Wd.sessionId)).toEqual([]);
  });

  const A = await spawnConductor(cc, false);
  const alpha = label('alpha');
  await api(cc, 'PUT', `/api/sessions/${A.sessionId}/title`, { title: alpha });
  const asks: string[] = [];

  await test.step('a text ask puts a conductor and a hand-spawned session in Waiting, marked as needing you', async () => {
    await mcpCall(cc, 'send_prompt', { sessionId: A.sessionId, text: 'ASK-TEXT' });
    await until(cc, A.id, 'A asks in text', (i) => i.status === 'idle' && i.awaitingUser === 'question' && i.awaitingUserSource === 'text');
    const s = await sample('A Waiting', (x) => only(x, A.sessionId, 'waiting'));
    const a = entryIn(s, 'waiting', A.sessionId)!;
    expect(a.text).toBe(alpha);
    expect(a.needsYou).toBe(true);
    asks.push(reasonOf(a));
    await expect(nextSidebar(page).locator(`[data-conductor="${A.sessionId}"] > [data-row] [data-dot]`), 'its conductor row is marked too')
      .toHaveAttribute('data-needs-you', 'true');
    await mcpCall(cc, 'send_prompt', { sessionId: H.sessionId, text: 'ASK-TEXT' });
    await until(cc, H.id, 'H asks in text', (i) => i.awaitingUser === 'question');
    const s2 = await sample('H Waiting', (x) => only(x, H.sessionId, 'waiting'));
    expect(entryIn(s2, 'waiting', H.sessionId)!.needsYou).toBe(true);
  });

  const Wa = await spawnWorker(cc, A.id, { project: P });
  workers.push(Wa.sessionId);
  await test.step('a waiting conductor idle on its worker stays in Waiting, not Running', async () => {
    await mcpCall(cc, 'send_prompt', { sessionId: Wa.sessionId, text: 'WORKER-GO' }, A.id);
    await until(cc, Wa.id, 'Wa in a turn', (i) => i.status === 'turn');
    await until(cc, A.id, 'A idle on its worker', (i) => i.status === 'idle' && !!i.awaitingWake);
    const s = await sample('A Waiting, on a worker', (x) => only(x, A.sessionId, 'waiting') && reasonOf(entryIn(x, 'waiting', A.sessionId)!) !== asks[0]);
    expect(entryIn(s, 'waiting', A.sessionId)!.needsYou).toBe(true);
  });

  await test.step('the worker callback re-invokes the waiting conductor: it stays in Waiting through the wake turn and after', async () => {
    await until(cc, Wa.id, 'Wa done', (i) => i.status === 'idle', 40_000);
    await until(cc, A.id, 'A re-invoked', (i) => i.status === 'turn', 20_000);
    expect((await byId(cc, A.id))!.awaitingUser, 'the API keeps the ask through the wake turn').toBe('question');
    const s = await sample('A Waiting in its wake turn', (x) => only(x, A.sessionId, 'waiting') && entryIn(x, 'waiting', A.sessionId)!.dot === 'turn', 8_000);
    expect(entryIn(s, 'waiting', A.sessionId)!.needsYou).toBe(true);
    await until(cc, A.id, 'A idle after the wake turn', (i) => i.status === 'idle');
    const after = await sample('A still Waiting', (x) => only(x, A.sessionId, 'waiting') && entryIn(x, 'waiting', A.sessionId)!.dot === 'idle');
    expect(entryIn(after, 'waiting', A.sessionId)!.needsYou).toBe(true);
    expect((await byId(cc, A.id))!.awaitingUser).toBe('question');
  });

  await test.step('opening the asking conductor from the strip, then a reply from the composer clears its ask', async () => {
    const entry = await next.stripEntry(page, A.sessionId);
    if (drawer()) await entry.tap();
    else await entry.click();
    await expect(next.sessionHeader(page).locator(`[title="session ${A.sessionId}"]`)).toBeVisible();
    if (drawer()) await expect.poll(() => next.drawerOpen(page), { message: 'a strip click closes the drawer' }).toBe(false);
    await next.sendPrompt(page, 'go ahead');
    await until(cc, A.id, 'the reply clears the ask', (i) => i.awaitingUser === null && i.status === 'idle');
    const s = await sample('A Finished', (x) => only(x, A.sessionId, 'finished'));
    const a = entryIn(s, 'finished', A.sessionId)!;
    expect(a.needsYou).toBe(false);
    expect(a.active, 'the opened entry is the selected one').toBe(true);
  });

  const resumeWithAsk = async (tool: string, input: unknown) => {
    const X = await spawnConductor(cc, false);
    await appendTranscriptRecord(cc, X.id, { type: 'user', message: { role: 'user', content: label('resume') } });
    await appendTranscriptRecord(cc, X.id, {
      type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'ta', name: tool, input }], stop_reason: 'tool_use' },
    });
    await api(cc, 'DELETE', `/api/instances/${X.id}`);
    await expect.poll(async () => { const x = await byId(cc, X.id); return !x || x.status === 'exited'; }, { message: `${X.sessionId} killed` }).toBe(true);
    await sample(`${X.sessionId} in no group while dead`, (x) => groupsOf(x, X.sessionId).length === 0);
    const r = await api(cc, 'POST', '/api/instances', { project: '.conduct', resume: X.sessionId, mode: 'bypassPermissions', playbookEnforcement: 'warn', ...liveModel(cc) });
    expect(r.status, `POST /api/instances (resume): ${JSON.stringify(r.body)}`).toBeLessThan(300);
    await idleInst(cc, (i) => i.id === r.body.id, `${X.sessionId} resumed idle`);
    const back = (await byId(cc, r.body.id))!;
    const s = await sample(`${X.sessionId} Waiting`, (x) => only(x, X.sessionId, 'waiting'));
    return { back, entry: entryIn(s, 'waiting', X.sessionId)! };
  };

  await test.step('a killed conductor leaves the strip; resumed onto a plan or a question transcript it is Waiting with that ask', async () => {
    const plan = await resumeWithAsk('ExitPlanMode', { plan: 'p' });
    expect([plan.back.awaitingUser, plan.back.awaitingUserSource]).toEqual(['plan', 'tool']);
    expect(plan.entry.needsYou).toBe(true);
    asks.push(reasonOf(plan.entry));
    const question = await resumeWithAsk('AskUserQuestion', { questions: [{ question: 'q' }] });
    expect([question.back.awaitingUser, question.back.awaitingUserSource]).toEqual(['question', 'tool']);
    expect(question.entry.needsYou).toBe(true);
    asks.push(reasonOf(question.entry));
  });

  await test.step('the three asks read distinctly, and every entry shows its label alone', async () => {
    expect(new Set(asks).size, JSON.stringify(asks)).toBe(3);
    const s = await readStrip(page);
    for (const e of Object.values(s ?? {}).flat()) {
      expect(e.name.startsWith(e.text), JSON.stringify(e)).toBe(true);
      expect(reasonOf(e), `${JSON.stringify(e)}: the reason is in the accessible name only`).not.toBe('');
    }
  });

  await test.step('the Projects lens shows the same strip', async () => {
    const sids = (s: Strip | null) => Object.values(s ?? {}).flat().map((e) => e.sid);
    const before = sids(await readStrip(page));
    expect(before.length).toBeGreaterThan(0);
    await next.lens(page, 'projects');
    await expect(nextSidebar(page).locator('[data-strip]')).toBeVisible();
    expect(sids(await readStrip(page))).toEqual(before);
    await next.lens(page, 'conductors');
  });

  await test.step('conducted workers are never listed', async () => {
    expect(workers).toHaveLength(2);
    expect(listed, 'workers any sample listed').toEqual([]);
    const s = await readStrip(page);
    for (const w of workers) expect(groupsOf(s, w)).toEqual([]);
  });
}

// Invariant: the sidebar does not overflow sideways; every strip × is reached from its entry by Tab, shown while focused,
// inside the viewport and not covered, and on touch it shows with no hover or focus at all; hovering an entry shows its ×;
// a real tap or click on the ×, or Enter or Space on the focused ×, closes the entry without opening it (a stop at once, an
// archive after its confirm); a strip click opens the session, closing the drawer.
export async function fitFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(180_000);
  const P = label('fit');
  await createProject(cc, P);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const c = await spawnConductor(cc, true);
  await api(cc, 'PUT', `/api/sessions/${c.sessionId}/title`, { title: label('a conductor title long enough to overflow the drawer row') });
  const spawnHand = async (temp: boolean) => {
    const r = await api(cc, 'POST', '/api/instances', { project: P, mode: 'bypassPermissions', temp, ...liveModel(cc) });
    expect(r.status, `POST /api/instances (hand): ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return idleInst(cc, (i) => i.id === r.body.id, 'hand-spawned session idle');
  };
  // Idle and persistent: its × stops it at once. Temp: its × asks before archiving.
  const stop = await spawnHand(false);
  const archive = await spawnHand(true);
  const enter = await spawnHand(false);
  const space = await spawnHand(false);
  const open = await spawnHand(false);
  await next.open(page);
  await next.openSidebar(page);
  const sb = nextSidebar(page);
  for (const s of [c, stop, archive, enter, space, open]) await expect(sb.locator(`[data-strip-entry="${s.sessionId}"]`)).toHaveCount(1);
  const rowOf = (sid: string) => sb.locator(`[data-strip-entry="${sid}"]`);
  const closeOf = (sid: string) => next.sessionClose(rowOf(sid));
  const opacity = (sid: string) => () => closeOf(sid).evaluate((e) => getComputedStyle(e).opacity);
  /** Closes `sid` through its × and checks the entry went without being opened. */
  const closed = async (s: FleetInst) => {
    await gone(cc, s.id);
    await expect(rowOf(s.sessionId)).toHaveCount(0);
    await expect(next.sessionHeader(page).locator(`[title="session ${s.sessionId}"]`)).toHaveCount(0);
    if (drawer()) expect(await next.drawerOpen(page), 'the × leaves the drawer open').toBe(true);
  };

  await test.step('the sidebar does not overflow sideways', async () => {
    const fit = await sb.evaluate((root) => {
      const body = root.querySelector('[data-sidebar-body]') as HTMLElement;
      return { body: body.scrollWidth, bodyBox: body.clientWidth, doc: document.documentElement.scrollWidth, viewport: window.innerWidth };
    });
    expect(fit.body, JSON.stringify(fit)).toBeLessThanOrEqual(fit.bodyBox);
    expect(fit.doc, JSON.stringify(fit)).toBeLessThanOrEqual(fit.viewport);
  });

  await test.step('every strip × is reached by Tab from its entry and shown, inside the viewport and not covered', async () => {
    const sids = await sb.locator('[data-strip-entry]').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-strip-entry')!));
    expect(sids.length).toBeGreaterThanOrEqual(6);
    // The pointer is parked off the strip, so no hover shows a × here.
    if (!drawer()) await page.mouse.move(1, 1);
    for (const sid of sids) {
      const x = closeOf(sid);
      await x.scrollIntoViewIfNeeded();
      // A finger has no hover: on touch the × must show with no hover or focus to be reachable at all.
      if (drawer()) await expect.poll(opacity(sid), { message: `${sid}: touch shows the × unprompted` }).toBe('1');
      await rowOf(sid).locator(':scope > button').focus();
      await page.keyboard.press('Tab');
      await expect(x, `${sid}: Tab from the entry reaches its ×`).toBeFocused();
      await expect.poll(opacity(sid), { message: `${sid}: keyboard focus shows the ×` }).toBe('1');
      await expect(x, sid).toBeInViewport({ ratio: 1 });
      expect(await x.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === e;
      }), `${sid}: nothing covers the ×`).toBe(true);
    }
  });

  await test.step('a real tap or click on the × closes the entry without opening it', async () => {
    const press = async (sid: string) => {
      if (drawer()) return closeOf(sid).tap();
      await rowOf(sid).hover();
      await expect.poll(opacity(sid), { message: `${sid}: hovering the entry shows its ×` }).toBe('1');
      await closeOf(sid).click();
    };
    await press(stop.sessionId);
    await closed(stop);
    await press(archive.sessionId);
    const confirm = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Archive', exact: true }) });
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
    await closed(archive);
  });

  await test.step('Enter or Space on the focused × closes the entry without opening it', async () => {
    for (const [s, key] of [[enter, 'Enter'], [space, 'Space']] as const) {
      await rowOf(s.sessionId).locator(':scope > button').focus();
      await page.keyboard.press('Tab');
      await expect(closeOf(s.sessionId)).toBeFocused();
      await page.keyboard.press(key);
      await closed(s);
    }
  });

  await test.step('a strip click opens the session and closes the drawer', async () => {
    const entry = await next.stripEntry(page, open.sessionId);
    if (drawer()) await entry.tap();
    else await entry.click();
    await expect(next.sessionHeader(page).locator(`[title="session ${open.sessionId}"]`)).toBeVisible();
    if (drawer()) await expect.poll(() => next.drawerOpen(page), { message: 'the drawer closed' }).toBe(false);
    await expect(await next.stripEntry(page, open.sessionId)).toHaveAttribute('data-active', 'true');
  });
}

// Invariant: an armed entry with a long label keeps its label rendered and truncating while the auto-resume badge gives
// way and truncates; the two do not overlap, both stay inside the entry, and the × stays inside the viewport.
export async function badgeFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(120_000);
  const P = label('badge');
  await createProject(cc, P);
  const r = await api(cc, 'POST', '/api/instances', { project: P, mode: 'bypassPermissions', temp: false, ...liveModel(cc) });
  expect(r.status, `POST /api/instances (hand): ${JSON.stringify(r.body)}`).toBeLessThan(300);
  const h = await idleInst(cc, (i) => i.id === r.body.id, 'hand-spawned session idle');
  const title = label('a strip label long enough to overflow its entry and need truncation');
  await api(cc, 'PUT', `/api/sessions/${h.sessionId}/title`, { title });
  // Arming a real auto-resume takes an account overage; the page's instance list is given the armed fields instead.
  const resumeAt = Math.round(Date.now() / 1000) + 3600;
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>[];
    for (const i of body) if (i.id === h.id) Object.assign(i, { autoResumeAt: resumeAt, queuedCount: 123456789 });
    await route.fulfill({ response: res, json: body });
  });
  await next.open(page);
  const entry = await next.stripEntry(page, h.sessionId);
  await expect(entry.locator('[data-resume-badge]')).toHaveCount(1);
  await expect(entry.locator('[data-strip-label]')).toHaveText(title);
  const m = await entry.evaluate((e) => {
    const box = (n: Element) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height }; };
    const l = e.querySelector('[data-strip-label]') as HTMLElement;
    const b = e.querySelector('[data-resume-badge]') as HTMLElement;
    return { entry: box(e), label: { ...box(l), overflow: l.scrollWidth > l.clientWidth }, badge: { ...box(b), overflow: b.scrollWidth > b.clientWidth } };
  });
  const detail = JSON.stringify(m);
  expect(m.label.width > 0 && m.label.height > 0, `the label renders: ${detail}`).toBe(true);
  expect(m.label.overflow, `the label truncates: ${detail}`).toBe(true);
  expect(m.badge.width > 0, `the badge renders: ${detail}`).toBe(true);
  expect(m.badge.overflow, `the badge truncates: ${detail}`).toBe(true);
  expect(m.label.right <= m.badge.left || m.badge.right <= m.label.left, `no overlap: ${detail}`).toBe(true);
  for (const part of [m.label, m.badge]) expect(part.left >= m.entry.left && part.right <= m.entry.right, `inside the entry: ${detail}`).toBe(true);
  await expect(next.sessionClose(nextSidebar(page).locator(`[data-strip-entry="${h.sessionId}"]`))).toBeInViewport({ ratio: 1 });
}
