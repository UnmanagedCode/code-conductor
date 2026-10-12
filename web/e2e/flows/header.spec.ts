import { expect, test } from './test.ts';
import { api, createProject, installFakePlugin, mcpCall } from '../harness/api.ts';

type Inst = { id: string; status: string; sessionId: string | null; callerInstanceId?: string | null };
const instances = async (cc: Parameters<typeof api>[0]) => (await api<Inst[]>(cc, 'GET', '/api/instances')).body;

test('opening Settings clears the session from the main bar, and leaving restores it', async ({ page, cc, ui, uniq }) => {
  const project = uniq('hdr');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  // toContainText matches a hidden element too: visibility is asserted on its own.
  await expect(ui.sessionHeader(page)).toBeVisible();
  await expect(ui.sessionHeader(page)).toContainText(project);
  await ui.openSettings(page);
  await expect(ui.sessionHeader(page)).toBeHidden();
  await ui.leaveSettings(page);
  await expect(ui.sessionHeader(page)).toBeVisible();
  await expect(ui.sessionHeader(page)).toContainText(project);
});

test('opening a plugin view clears the session from the main bar, and leaving restores it', async ({ page, cc, ui, uniq }) => {
  // Before open: the web UI's app switcher reads the plugin catalog when it mounts.
  await installFakePlugin(cc, 'fakeplug');
  try {
    const project = uniq('plug');
    await createProject(cc, project);
    await ui.open(page);
    await ui.startSessionIn(page, project);
    await expect(ui.sessionHeader(page)).toBeVisible();
    await expect(ui.sessionHeader(page)).toContainText(project);
    await ui.openPlugin(page, 'fake-plugin');
    await expect(ui.sessionHeader(page)).toBeHidden();
    await ui.leavePlugin(page);
    await expect(ui.sessionHeader(page)).toBeVisible();
    await expect(ui.sessionHeader(page)).toContainText(project);
  } finally {
    // The flow files share one cc.
    await api(cc, 'POST', '/api/plugins/fake-plugin/disable');
  }
});

test('opening a conductor from its sidebar row shows its title and its workers', async ({ page, cc, ui, uniq }) => {
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  // `warn`, so the conductor may spawn an unbound worker.
  const spawned = await api(cc, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'warn' });
  expect(spawned.status, JSON.stringify(spawned.body)).toBeLessThan(300);
  const id: string = spawned.body.id;
  let sessionId: string | null = null;
  await expect.poll(async () => {
    const row = (await instances(cc)).find((i) => i.id === id);
    sessionId = row?.status === 'idle' ? row.sessionId : null;
    return sessionId;
  }).not.toBeNull();
  const title = uniq('Conductor');
  await api(cc, 'PUT', `/api/sessions/${sessionId}/title`, { title });
  const project = uniq('wk');
  await createProject(cc, project);
  // The MCP caller is the conductor's instance id, as a worker's MCP client sends it.
  const r = await mcpCall(cc, 'spawn_instance', { project, mode: 'bypassPermissions' }, id);
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  await expect.poll(async () => (await instances(cc)).some((i) => i.callerInstanceId === id && i.status === 'idle')).toBe(true);

  await ui.open(page);
  await ui.openConductor(page, sessionId!);
  await expect(ui.sessionHeader(page)).toContainText(title);
  await expect(ui.workersPanel(page)).toBeVisible();
});

test('with no turn running, Terminate asks first: declining keeps the session, confirming stops it', async ({ page, cc, ui, uniq }) => {
  const project = uniq('term');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project, { temp: false });
  await expect(ui.sessionHeader(page)).toContainText(project);
  await expect(ui.composer(page)).toBeEnabled();
  await ui.terminate(page, false);
  await expect(ui.resumeButton(page)).toBeHidden();
  await expect(ui.composer(page)).toBeEnabled();
  await ui.terminate(page, true);
  await expect(ui.resumeButton(page)).toBeVisible();
});

test('a stopped session offers Resume, which brings it back', async ({ page, cc, ui, uniq }) => {
  const project = uniq('resume');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project, { temp: false });
  await expect(ui.sessionHeader(page)).toContainText(project);
  await expect(ui.composer(page)).toBeEnabled();
  await ui.terminate(page, true);
  await expect(ui.resumeButton(page)).toBeVisible();
  await ui.resumeButton(page).click();
  await expect(ui.resumeButton(page)).toBeHidden();
  await expect(ui.composer(page)).toBeEnabled();
});
