// cc's REST and MCP surfaces, called the way a spec needs them. Every helper
// takes the booted `cc` and talks to it with plain fetch, so a debug script
// outside the test runner can use them too.

import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { REPO_ROOT, type Cc } from './boot.ts';

/** The model a LIVE worker under test runs on. Fake workers ignore the model. */
export const LIVE_WORKER_MODEL = 'claude-haiku-5-5';

export type ApiResult<T = any> = { status: number; body: T };

export async function api<T = any>(cc: Pick<Cc, 'url'>, method: string, route: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(cc.url + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function createProject(cc: Pick<Cc, 'url'>, name: string): Promise<void> {
  const r = await api(cc, 'POST', '/api/projects', { name });
  expect(r.status, `POST /api/projects ${name}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
}

/** Creates `project` if needed and spawns a session in it; a live cc's worker runs on LIVE_WORKER_MODEL. */
export async function spawnSession(
  cc: Pick<Cc, 'url' | 'engine'>, project: string, extra: Record<string, unknown> = {},
): Promise<{ id: string; sessionId: string }> {
  await api(cc, 'POST', '/api/projects', { name: project });
  const r = await api(cc, 'POST', '/api/instances', {
    project, mode: 'bypassPermissions', ...(cc.engine === 'live' ? { model: LIVE_WORKER_MODEL } : {}), ...extra,
  });
  expect(r.status, `POST /api/instances: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body as { id: string; sessionId: string };
}

const FAKE_PLUGIN = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-plugin');

/**
 * Makes the fixture plugin (`tests/fixtures/fake-plugin`, id `fake-plugin`) installed, adopted as project `name`,
 * and enabled. Idempotent per cc: a plugin already listed is neither copied nor rescanned, a project already
 * adopted is not adopted again, and the enable always runs.
 */
export async function installFakePlugin(cc: Pick<Cc, 'url' | 'dirs'>, name: string): Promise<void> {
  const listed = ((await api(cc, 'GET', '/api/plugins')).body.rows as { id: string }[]).some((r) => r.id === 'fake-plugin');
  const adopted = ((await api(cc, 'GET', '/api/projects')).body as { name: string }[]).some((p) => p.name === name);
  const dir = path.join(cc.dirs.projects, name);
  if (!adopted) {
    if (!fs.existsSync(dir)) fs.cpSync(FAKE_PLUGIN, dir, { recursive: true });
    const adopt = await api(cc, 'POST', '/api/projects/external', { name, path: dir });
    expect(adopt.body?.ok, `adopt ${name}: ${JSON.stringify(adopt.body)}`).toBe(true);
  }
  if (!listed) await api(cc, 'POST', '/api/plugins/rescan');
  const enable = await api(cc, 'POST', '/api/plugins/fake-plugin/enable');
  expect(enable.status, `enable fake-plugin: ${JSON.stringify(enable.body)}`).toBeLessThan(300);
}

let rpcId = 1;
/** One MCP `tools/call`; `caller` is the calling instance id, as a worker's MCP client sends it. */
export async function mcpCall(cc: Pick<Cc, 'url'>, name: string, args: Record<string, unknown>, caller?: string): Promise<any> {
  const res = await fetch(cc.url + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}
