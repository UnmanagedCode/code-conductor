// A script a worker runs: it imports the generated Node client from
// $CONDUCTOR_MCP_CLIENT_DIR and calls through a default-constructed
// ConductorClient, so the call goes to $CONDUCTOR_MCP_URL — the worker's own
// session. Records {dir, result} (or {dir, error}) to $MCP_SCRIPT_OUT. Run by
// tests/fixtures/claude-runs-mcp-script.mjs when MCP_SCRIPT names this file.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.CONDUCTOR_MCP_CLIENT_DIR;
const record = { dir: dir ?? null };
try {
  const { ConductorClient, ConductorError } = await import(pathToFileURL(path.join(dir, 'conductor_client.mjs')).href);
  const client = new ConductorClient();
  // The worker's process is registered a moment after it starts this script;
  // retry while the session is not yet a live caller.
  for (let i = 0; ; i++) {
    try { record.result = await client.set_session_title({ title: 'client' }); break; } catch (e) {
      if (!(e instanceof ConductorError) || e.code !== 'CALLER_UNKNOWN' || i >= 100) throw e;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
} catch (e) {
  record.error = String(e);
}
fs.writeFileSync(process.env.MCP_SCRIPT_OUT, JSON.stringify(record));
