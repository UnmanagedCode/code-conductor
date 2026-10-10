// Opt-in live smoke: a real `claude` worker (from PATH) on LIVE_WORKER_MODEL,
// signed in with an access-token-only copy of the live credentials, all state
// in the scratch root. Skipped unless CC_E2E_LIVE=1; desktop project only.
//
// The token never reaches the page and nothing here prints it: no trace,
// screenshot or video, and every log tail or event dump goes through redact().
// A CLI that stops (onboarding, trust, auth) fails the test with its own words.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, spawnSession, LIVE_WORKER_MODEL } from './harness/api.ts';
import { redact } from './harness/redact.ts';

test.skip(process.env.CC_E2E_LIVE !== '1', 'live mode: set CC_E2E_LIVE=1');
test.use({ ccOptions: { engine: 'live', server: 'live' }, trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(240_000);

function jsonlsUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
}

/** What the CLI said, for a failure message: the session's last events and the server log tail, redacted. */
async function diagnosis(cc: Cc, id: string): Promise<string> {
  const events = await api(cc, 'GET', `/api/instances/${id}/events?limit=20`).catch((e) => ({ body: String(e) }));
  const log = fs.existsSync(cc.logPath) ? fs.readFileSync(cc.logPath, 'utf8').slice(-8192) : '(no server log)';
  return redact(`last events:\n${JSON.stringify(events.body, null, 1)}\nserver log tail:\n${log}`);
}

test('a live worker answers a prompt through /next/, isolated in the scratch root', async ({ page, cc }) => {
  await createProject(cc, 'e2e-live');
  const { id, sessionId } = await spawnSession(cc, 'e2e-live');

  const list = await api<Array<{ id: string; model: string | null }>>(cc, 'GET', '/api/instances');
  expect(list.body.find((i) => i.id === id)?.model).toBe(LIVE_WORKER_MODEL);

  await page.goto(`/next/#session=${sessionId}`);
  const composer = page.locator('#composer-input');
  await expect(composer).toBeEnabled();
  await composer.fill('Reply with the single word: pong');
  await composer.press('Enter');
  try {
    await expect(page.locator('[data-item=assistant]').first()).toContainText(/pong/i, { timeout: 180_000 });
  } catch {
    throw new Error(`live mode: no assistant reply.\n${await diagnosis(cc, id)}`);
  }

  expect(jsonlsUnder(path.join(cc.dirs.claudeConfig, 'projects')).length, 'a transcript jsonl under the scratch config dir').toBeGreaterThan(0);

  const log = fs.readFileSync(cc.logPath, 'utf8');
  expect(redact(log) === log, 'server.log contains the access token').toBe(true);
});
