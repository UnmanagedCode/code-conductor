// The harness's own self-test, run in every project: the bundle is current, the
// booted cc is isolated in one scratch root with its own port, the default
// engine is the fake CLI end to end, the web UI is served at /, and close()
// removes the root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { webSourceHash, WEB_DIST } from '../../src/webBuild.ts';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { bootCc, FIXTURES } from './harness/boot.ts';

const under = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

function readEnvDump(file: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
  }
  return env;
}

test('web/dist was built from the current sources', () => {
  expect(fs.readFileSync(path.join(WEB_DIST, '.source-hash'), 'utf8').trim()).toBe(webSourceHash());
});

test('the booted cc lives in one scratch root under the temp dir, on its own port', ({ cc }) => {
  const root = cc.dirs.root;
  expect(path.dirname(root)).toBe(os.tmpdir());
  for (const [name, p] of Object.entries(cc.dirs)) expect(under(root, p), `dirs.${name}`).toBe(true);
  expect(cc.logPath).toBe(cc.dirs.log);
  expect(cc.port).not.toBe(8787);
  expect(cc.url).toBe(`http://127.0.0.1:${cc.port}`);
  expect(cc.engine).toBe('fake');
});

test('the default engine is the fake CLI, end to end, with an isolated worker env', async ({ page, cc }) => {
  const { sessionId } = await spawnSession(cc, `e2e-harness-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  const composer = page.locator('#composer-input');
  await expect(composer).toBeEnabled();
  await composer.fill('Add a rate limiter to the API');
  await composer.press('Enter');
  await expect(page.locator('[data-item=assistant]').first()).toContainText('token-bucket rate limiter');

  const env = readEnvDump(cc.dirs.workerEnv);
  for (const k of ['CLAUDE_CONFIG_DIR', 'HOME', 'CC_PROJECTS_ROOT']) {
    expect(env.get(k), `${k} in the worker env`).toBeTruthy();
    expect(under(cc.dirs.root, env.get(k)!), `${k}=${env.get(k)} is under the scratch root`).toBe(true);
  }
  expect(env.get('CLAUDE_BIN')).toContain(path.join('tests', 'fake-claude.mjs'));
  expect(env.has('CLAUDECODE')).toBe(false);
  expect(env.has('CLAUDE_CODE_SESSION_ID')).toBe(false);
});

test('/ serves the web UI', async ({ request }) => {
  const root = await request.get('/');
  expect(root.status()).toBe(200);
  expect(await root.text()).toContain('<div id="root"></div>');
});

test('bootCc() then close() leaves no scratch root behind', async () => {
  const cc = await bootCc();
  const root = cc.dirs.root;
  expect(fs.existsSync(root)).toBe(true);
  await cc.close();
  expect(fs.existsSync(root)).toBe(false);
});

/** Alive and not a zombie (a reaped-late zombie is already dead). */
function running(pid: number): boolean {
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.trim() !== '' && !ps.stdout.trim().startsWith('Z');
}

test('close() kills every descendant of the booted cc, a detached SIGTERM-deaf one included', async ({}, testInfo) => {
  const pidFile = testInfo.outputPath('orphan-pids.txt');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, '');
  const cc = await bootCc({ env: {
    CLAUDE_BIN: `${process.execPath} ${path.join(FIXTURES, 'claude-leaves-orphan.mjs')}`,
    E2E_ORPHAN_PIDS: pidFile,
  } });
  let pid = 0;
  try {
    await spawnSession(cc, 'e2e-orphan');
    await expect.poll(() => fs.readFileSync(pidFile, 'utf8').trim(), { message: 'the worker recorded its grandchild' }).not.toBe('');
    const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n');
    expect(pids, 'one session worker, one orphan').toHaveLength(1);
    pid = Number(pids[0]);
    // Controls: the grandchild is alive, leads its own process group (so no
    // group kill of cc or of its worker reaches it), and survives a SIGTERM.
    expect(running(pid)).toBe(true);
    expect(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()).toBe(String(pid));
    process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    expect(running(pid), 'the grandchild ignores SIGTERM').toBe(true);
  } finally {
    await cc.close();
  }
  const survived = running(pid);
  if (survived) process.kill(pid, 'SIGKILL');
  expect(survived, `descendant ${pid} outlived close()`).toBe(false);
});

