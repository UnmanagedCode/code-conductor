import { api, createProject, spawnSession } from '../harness/api.ts';
import { expect, type Cc } from '../harness/fixtures.ts';
import { seedTranscript } from '../harness/transcript.ts';
import { parity } from './parity.ts';

parity('legacy-sidebar-lenses/R1', 'a fresh profile opens on the Conductors lens, and the chosen lens survives a reload', async ({ page, ui }) => {
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('conductors');
  await ui.lens(page, 'projects');
  await page.reload();
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('projects');
});

parity('spawn-dialog-server-resolves/R2', 'Conduct POSTs exactly {project, role, temp, mode} and opens the new conductor', async ({ page, cc, ui }) => {
  await ui.open(page);
  const spawn = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await ui.conduct(page);
  const req = await spawn;
  expect(req.postDataJSON()).toEqual({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
  const { id } = await (await req.response())!.json();
  // The new conductor's session id, once cc reports it.
  let sid: string | null = null;
  await expect.poll(async () => {
    sid = ((await api(cc, 'GET', '/api/instances')).body as { id: string; sessionId: string | null }[])
      .find((i) => i.id === id)?.sessionId ?? null;
    return sid;
  }).not.toBeNull();
  const header = ui.sessionHeader(page);
  await expect(header).toBeVisible();
  await expect(header).not.toContainText('no instance selected');
  await expect(header.locator(`[title="session ${sid}"]`)).toBeVisible();
});

parity('adopt-dialog-markup/R1', 'the ≡ menu opens the Add-project dialog', async ({ page, ui }) => {
  await ui.open(page);
  const dialog = await ui.openAddProject(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Add a project');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
});

// Sidebar B (card 2026-0628)
type LiveInst = { id: string; status: string; sessionId: string | null; worktree?: { worktreeName: string } | null };
/** Spawns a persistent session in `project`, waits for it to idle, seeds its transcript; returns the instance. */
async function persistentSession(cc: Cc, project: string, text: string, extra: Record<string, unknown> = {}): Promise<LiveInst> {
  const { id } = await spawnSession(cc, project, { temp: false, ...extra });
  let row: LiveInst | undefined;
  await expect.poll(async () => {
    row = ((await api(cc, 'GET', '/api/instances')).body as LiveInst[]).find((i) => i.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  await seedTranscript(cc, id, text);
  return row!;
}

parity('sidebar/R2', 'a live session row in the Projects lens opens it, and once stopped its row resumes it', async ({ page, cc, ui, uniq }) => {
  // Invariant: a live row opens its session, and the stopped session's row resumes it with exactly {project, resume}.
  const project = uniq('rows');
  await createProject(cc, project);
  const inst = await persistentSession(cc, project, 'rows first prompt');
  const sid = inst.sessionId!;
  await ui.open(page);
  await expect.poll(async () => ui.sessionRowLive(await ui.sessionRow(page, project, sid))).toBe(true);
  await (await ui.sessionRow(page, project, sid)).click();
  await expect(ui.sessionHeader(page).locator(`[title="session ${sid}"]`)).toBeVisible();
  await api(cc, 'DELETE', `/api/instances/${inst.id}`);
  await expect.poll(async () => ui.sessionRowLive(await ui.sessionRow(page, project, sid))).toBe(false);
  const resume = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await (await ui.sessionRow(page, project, sid)).click();
  expect((await resume).postDataJSON()).toEqual({ project, resume: sid });
  await expect(ui.sessionHeader(page).locator(`[title="session ${sid}"]`)).toBeVisible();
});

parity('doc/A6', 'the main checkout and a worktree each head their Sessions list with Sessions (N) · K live · last <ago>', async ({ page, cc, ui, uniq }) => {
  // Invariant: the summary text is visible on the main checkout's list and on the worktree's.
  const project = uniq('summ');
  await createProject(cc, project);
  // Per place: one stopped session on disk, and one live session not on disk yet.
  const stopped = await persistentSession(cc, project, 'main prompt');
  const w = await persistentSession(cc, project, 'worktree prompt', { worktree: true });
  const worktree = w.worktree!.worktreeName;
  const { id: liveMain } = await spawnSession(cc, project, { temp: false });
  const { id: liveWt } = await spawnSession(cc, project, { temp: false, worktree });
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
  const SUMMARY = /^Sessions \(2\) · 1 live · last \d+[sm] ago$/;
  const main = await ui.sessionsSummary(page, project, null);
  await expect(main).toBeVisible();
  await expect(main).toHaveText(SUMMARY);
  const wtSummary = await ui.sessionsSummary(page, project, worktree);
  await expect(wtSummary).toBeVisible();
  await expect(wtSummary).toHaveText(SUMMARY);
});
