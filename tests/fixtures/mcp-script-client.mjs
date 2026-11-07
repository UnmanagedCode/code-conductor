// A script a worker runs: it reaches its own session's MCP server through
// $CONDUCTOR_MCP_URL alone — a raw JSON-RPC tools/call with no initialize
// handshake, then the REST alias — and records both answers to
// $MCP_SCRIPT_OUT as JSON. Run by tests/fixtures/claude-runs-mcp-script.mjs.
import fs from 'node:fs';

const url = process.env.CONDUCTOR_MCP_URL;
const out = process.env.MCP_SCRIPT_OUT;

async function post(target, body) {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The worker's process is registered a moment after it starts this script;
// retry while the session is not yet live.
async function untilLive(send) {
  for (let i = 0; i < 100; i++) {
    const r = await send();
    if (r.body?.error?.data?.code !== 'CALLER_UNKNOWN' && r.body?.code !== 'CALLER_UNKNOWN') return r;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('the session never became a live caller');
}

const record = { url };
try {
  record.rpc = await untilLive(() => post(url, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'set_session_title', arguments: { title: 'rpc' } },
  }));
  record.rest = await untilLive(() => post(`${url}/tools/set_session_title`, { title: 'rest' }));
} catch (e) {
  record.error = String(e);
}
fs.writeFileSync(out, JSON.stringify(record));
