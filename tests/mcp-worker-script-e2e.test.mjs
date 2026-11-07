// End to end: a worker's script drives cc through the URL cc hands it.
//
// A real worker process (bootServer realProcess) whose CLI runs a script with
// its inherited env (tests/fixtures/claude-runs-mcp-script.mjs). The script uses
// nothing but $CONDUCTOR_MCP_URL: a JSON-RPC tools/call with no initialize, then
// the REST alias. Both must succeed and be attributed to THAT worker — its
// title follows each call in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { getTitle } from '../src/sessionStore.ts';

const SCENARIO = path.join(import.meta.dirname, 'fixtures', 'scenario-basic.json');
const WRAPPER = path.join(import.meta.dirname, 'fixtures', 'claude-runs-mcp-script.mjs');

test('a worker script reaches its own session through CONDUCTOR_MCP_URL — JSON-RPC and REST', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO, realProcess: true });
  const out = path.join(await mkdtemp('cc-mcp-script-'), 'record.json');
  process.env.CLAUDE_BIN = `${process.execPath} ${WRAPPER}`;
  process.env.MCP_SCRIPT_OUT = out;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'scripted' });
    const r = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'scripted', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sid = r.body.sessionId;
    await waitFor(async () => { try { await fs.stat(out); return true; } catch { return false; } }, { timeout: 20000 });
    const record = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.equal(record.error, undefined, record.error);
    assert.equal(record.url, `${srv.baseUrl}/mcp/${sid}`);
    assert.deepEqual(record.rpc.body.result.structuredContent, { sessionId: sid, title: 'rpc' }, 'JSON-RPC, JSON by default, as the worker');
    assert.deepEqual(record.rest, { status: 200, body: { sessionId: sid, title: 'rest' } }, 'the REST alias, as the worker');
    assert.equal(await getTitle(sid), 'rest', 'each call titled the worker in turn');
    assert.equal(instForSession(srv.instances, sid).title, 'rest');
  } finally {
    delete process.env.MCP_SCRIPT_OUT;
    await srv.close();
  }
});
