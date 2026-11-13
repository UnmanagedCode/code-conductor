import type { Locator } from '@playwright/test';
import { api, createProject, spawnSession } from '../harness/api.ts';
import { expect, test, type Cc } from './test.ts';
import { seedTranscript } from '../harness/transcript.ts';
import { spawnConductor, spawnWorker } from './fleet.ts';

test('a fresh profile opens on the Conductors lens, and the chosen lens survives a reload', async ({ page, ui }) => {
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('conductors');
  await ui.lens(page, 'projects');
  await page.reload();
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('projects');
});

test('Conduct POSTs exactly {project, role, mode, pristine} and opens the new conductor', async ({ page, ui }) => {
  await ui.open(page);
  const spawn = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await ui.conduct(page);
  const req = await spawn;
  expect(req.postDataJSON()).toEqual({ project: '.conduct', role: 'conductor', mode: 'bypassPermissions', pristine: true });
  // A pristine conductor is in no list, so its session id is read off the create's answer.
  const { sessionId: sid } = await (await req.response())!.json() as { sessionId: string };
  expect(sid).toBeTruthy();
  const header = ui.sessionHeader(page);
  await expect(header).toBeVisible();
  await expect(header).not.toContainText('no instance selected');
  await expect(header.locator(`[title="session ${sid}"]`)).toBeVisible();
});

test('the ≡ menu opens the Add-project dialog', async ({ page, ui }) => {
  await ui.open(page);
  const dialog = await ui.openAddProject(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Add a project');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
});

// Sidebar B (card 2026-0628)
/** Pixel 7 projects (phone, android) show the sidebar as a drawer. */
const drawerViewport = () => test.info().project.name !== 'desktop';
/**
 * Whether a summary line shows every fact whole: no horizontal overflow, and each of `<noun> (N)`, `K live` and
 * `last <ago>` laid out as one unbroken piece inside the line's box. Read off the text's own layout, so a clipped
 * (ellipsised) fact and a fact split across two lines both fail, whatever the markup.
 */
const factsFit = (summary: Locator) => summary.evaluate((e) => {
  const text = e.textContent ?? '';
  const facts = [/^.*?\(\d+\)/, /\d+ live/, /last \S+ ago/].map((re) => re.exec(text)).filter((m): m is RegExpExecArray => !!m);
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const at = (offset: number): [Text, number] => {
    for (const n of nodes) { if (offset <= n.length) return [n, offset]; offset -= n.length; }
    return [nodes[nodes.length - 1], nodes[nodes.length - 1].length];
  };
  const box = e.getBoundingClientRect();
  const placed = facts.map((m) => {
    const range = document.createRange();
    range.setStart(...at(m.index));
    range.setEnd(...at(m.index + m[0].length));
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const lines = new Set(rects.map((r) => Math.round(r.top))).size;
    const inside = rects.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5);
    return { fact: m[0], lines, inside };
  });
  const overflow = e.scrollWidth - e.clientWidth;
  return { overflow, placed, fits: facts.length === 3 && overflow <= 1 && placed.every((f) => f.lines === 1 && f.inside) };
});
type LiveInst = { id: string; status: string; sessionId: string | null; worktree?: { worktreeName: string } | null };
/** Spawns a persistent session in `project`, waits for it to idle, seeds its transcript; returns the instance. */
async function persistentSession(cc: Cc, project: string, text: string, extra: Record<string, unknown> = {}): Promise<LiveInst> {
  const { id } = await spawnSession(cc, project, { persistent: true, ...extra });
  let row: LiveInst | undefined;
  await expect.poll(async () => {
    row = ((await api(cc, 'GET', '/api/instances')).body as LiveInst[]).find((i) => i.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  await seedTranscript(cc, id, text);
  return row!;
}

test('a live session row in the Projects lens opens it, and once stopped its row resumes it', async ({ page, cc, ui, uniq }) => {
  // Invariant: a live row opens its session, and the stopped session's row resumes it with exactly {project, resume}.
  const project = uniq('rows');
  await createProject(cc, project);
  const inst = await persistentSession(cc, project, 'rows first prompt');
  const sid = inst.sessionId!;
  await ui.open(page);
  await expect.poll(async () => ui.sessionRowLive(await ui.sessionRow(page, project, sid))).toBe(true);
  if (drawerViewport()) {
    // Invariant: on touch, a live row's × shows with no hover and takes taps.
    const close = ui.sessionClose(await ui.sessionRow(page, project, sid));
    await expect(close).toBeVisible();
    expect(await close.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    expect(await close.evaluate((e) => getComputedStyle(e).pointerEvents)).not.toBe('none');
  }
  await (await ui.sessionRow(page, project, sid)).click();
  // Invariant: on a drawer viewport, tapping a session row closes the drawer.
  if (drawerViewport()) await expect.poll(() => ui.drawerOpen(page)).toBe(false);
  await expect(ui.sessionHeader(page).locator(`[title="session ${sid}"]`)).toBeVisible();
  await api(cc, 'DELETE', `/api/instances/${inst.id}`);
  await expect.poll(async () => ui.sessionRowLive(await ui.sessionRow(page, project, sid))).toBe(false);
  const resume = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await (await ui.sessionRow(page, project, sid)).click();
  expect((await resume).postDataJSON()).toEqual({ project, resume: sid });
  if (drawerViewport()) await expect.poll(() => ui.drawerOpen(page)).toBe(false);
  await expect(ui.sessionHeader(page).locator(`[title="session ${sid}"]`)).toBeVisible();
});

test('the main checkout and a worktree each head their Sessions list with Persistent sessions (N) · K live · last <ago>, every fact shown whole', async ({ page, cc, ui, uniq }) => {
  // Invariant: the summary text is visible on the main checkout's list and on the worktree's.
  const project = uniq('summ');
  await createProject(cc, project);
  // Per place: one stopped session on disk, and one live session not on disk yet.
  const stopped = await persistentSession(cc, project, 'main prompt');
  const w = await persistentSession(cc, project, 'worktree prompt', { worktree: true });
  const worktree = w.worktree!.worktreeName;
  // Every session is persistent, so each place's one visible group names its summary: the longest noun.
  const { id: liveMain } = await spawnSession(cc, project, { persistent: true });
  const { id: liveWt } = await spawnSession(cc, project, { persistent: true, worktree });
  for (const id of [stopped.id, w.id]) await api(cc, 'DELETE', `/api/instances/${id}`);
  const place = (i: LiveInst) => i.worktree?.worktreeName ?? null;
  await expect.poll(async () => ((await api(cc, 'GET', '/api/instances')).body as (LiveInst & { project: string })[])
    .filter((i) => i.project === project)
    .map((i) => `${i.id}@${place(i)}:${i.status}`)
    .sort()).toEqual([`${liveMain}@null:idle`, `${liveWt}@${worktree}:idle`].sort());
  const live = (await api(cc, 'GET', '/api/instances')).body as LiveInst[];
  const sidOf = (id: string) => live.find((i) => i.id === id)!.sessionId;
  const proj = ((await api(cc, 'GET', '/api/projects')).body as { name: string; sessions: { count: number }; worktrees: { worktreeName: string; sessions: { count: number } }[] }[])
    .find((p) => p.name === project)!;
  expect(proj.sessions.count).toBe(1);
  expect(proj.worktrees.find((x) => x.worktreeName === worktree)!.sessions.count).toBe(1);
  const diskMain = ((await api(cc, 'GET', `/api/projects/${project}/sessions`)).body as { sessionId: string }[]).map((r) => r.sessionId);
  const diskWt = ((await api(cc, 'GET', `/api/projects/${project}/worktrees/${worktree}/sessions`)).body as { sessionId: string }[]).map((r) => r.sessionId);
  expect(diskMain).toEqual([stopped.sessionId]);
  expect(diskWt).toEqual([w.sessionId]);
  expect(diskMain).not.toContain(sidOf(liveMain));
  expect(diskWt).not.toContain(sidOf(liveWt));
  await ui.open(page);
  const SUMMARY = /^Persistent sessions \(2\) · 1 live · last \d+[sm] ago$/;
  const main = await ui.sessionsSummary(page, project, null);
  await expect(main).toBeVisible();
  await expect(main).toHaveText(SUMMARY);
  // Invariant: no fact of the summary is clipped or split, at the default sidebar width.
  const mainFit = await factsFit(main);
  expect(mainFit.fits, JSON.stringify(mainFit)).toBe(true);
  const wtSummary = await ui.sessionsSummary(page, project, worktree);
  await expect(wtSummary).toBeVisible();
  await expect(wtSummary).toHaveText(SUMMARY);
  const wtFit = await factsFit(wtSummary);
  expect(wtFit.fits, JSON.stringify(wtFit)).toBe(true);
});

test('a place whose only sessions are conducted heads its list with Conducted sessions (N) · K live · last <ago>, every fact shown whole', async ({ page, cc, ui, uniq }) => {
  // Invariant: the conducted-only noun leaves the count and the live/last facts unclipped and unsplit too.
  const project = uniq('summc');
  await createProject(cc, project);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const conductor = await spawnConductor(cc, true);
  // One stopped conducted session on disk (persisted, so its stop keeps it listed) and one live.
  const stopped = await spawnWorker(cc, conductor.sessionId, { project });
  expect((await api(cc, 'POST', `/api/instances/${stopped.id}/persist`)).status).toBe(200);
  await seedTranscript(cc, stopped.id, 'conducted prompt');
  await api(cc, 'DELETE', `/api/instances/${stopped.id}`);
  await spawnWorker(cc, conductor.sessionId, { project });
  await ui.open(page);
  const main = await ui.sessionsSummary(page, project, null);
  await expect(main).toHaveText(/^Conducted sessions \(2\) · 1 live · last \d+[sm] ago$/);
  const fit = await factsFit(main);
  expect(fit.fits, JSON.stringify(fit)).toBe(true);
});
