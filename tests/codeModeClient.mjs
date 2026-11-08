// Shared by the run_code tests: a booted server with live fake-CLI sessions,
// and the two ways to call run_code as one of them.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_BASIC = path.join(__dirname, 'fixtures', 'scenario-basic.json');

export async function spawnIdle(srv, project, mode = 'bypassPermissions') {
  const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project, mode });
  assert.equal(spawn.status, 201, JSON.stringify(spawn.body));
  const sid = spawn.body.sessionId;
  await waitFor(() => instForSession(srv.instances, sid)?.status === 'idle');
  return instForSession(srv.instances, sid);
}

export async function bootWithSession({ project = 'rc-proj', mode = 'bypassPermissions', ...bootOpts } = {}) {
  const srv = await bootServer({ scenarioPath: SCENARIO_BASIC, ...bootOpts });
  await api(srv.baseUrl, 'POST', '/api/projects', { name: project });
  const inst = await spawnIdle(srv, project, mode);
  return { srv, inst, sid: inst.sessionId };
}

// run_code over the REST alias, as session `sid`: the structured result.
export async function runCodeRest(srv, sid, code, extra = {}) {
  const res = await fetch(`${srv.baseUrl}/mcp/${sid ? encodeURIComponent(sid) + '/' : ''}tools/run_code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

// run_code over JSON-RPC in the text format (the agent view): the content blocks.
export async function runCodeText(srv, sid, code, extra = {}) {
  const res = await fetch(`${srv.baseUrl}/mcp/${encodeURIComponent(sid)}?format=text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_code', arguments: { code, ...extra } } }),
  });
  return (await res.json()).result;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
