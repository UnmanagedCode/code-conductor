// docs/mcp-applications.md's samples are the server's real bytes: each marked
// block (`<!-- doc-sample: NAME -->` + a fenced block) is replayed, in order,
// against a live server on a fresh store, and the documented response must be
// exactly what comes back. The JSON-RPC request is POSTed as written; the curl
// line is parsed (URL, header, body) and replayed via fetch; the Python samples
// run under `python3 -I -B` and the Node client sample under this node, with
// CONDUCTOR_MCP_URL pointing at the server and CONDUCTOR_MCP_CLIENT_DIR at the
// generated clients. A Python sample is skipped with a log when no python3 is
// installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { bootServer } from './helpers.mjs';
import * as projects from '../src/projects.ts';

const DOC = path.join(import.meta.dirname, '..', 'docs', 'mcp-applications.md');
const DOC_BASE = 'http://127.0.0.1:8787';

function samples() {
  const out = new Map();
  const re = /<!-- doc-sample: ([\w-]+) -->\n```\w*\n([\s\S]*?)\n```/g;
  for (const m of readFileSync(DOC, 'utf8').matchAll(re)) out.set(m[1], m[2]);
  return out;
}

function run(cmd, args, env) {
  return new Promise(resolve => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}
const python3 = (code, env) => run('python3', ['-I', '-B', '-c', code], env);

test('every documented sample replays to its documented bytes', async (t) => {
  const s = samples();
  for (const name of ['rpc-request', 'rpc-response', 'curl', 'curl-response', 'python', 'python-output',
    'node-client', 'node-client-output', 'python-client', 'python-client-output']) {
    assert.ok(s.has(name), `docs/mcp-applications.md lost its '${name}' sample`);
  }
  const srv = await bootServer({});
  try {
    const rpc = await fetch(`${srv.baseUrl}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: s.get('rpc-request'),
    });
    assert.equal(await rpc.text(), s.get('rpc-response'));

    const curl = s.get('curl');
    const url = curl.match(/curl -s -X POST (\S+)/)[1];
    const header = curl.match(/-H '([^:]+): ([^']+)'/);
    const body = curl.match(/-d '([^']*)'/)[1];
    assert.ok(url.startsWith(DOC_BASE), url);
    const rest = await fetch(srv.baseUrl + url.slice(DOC_BASE.length), {
      method: 'POST', headers: { [header[1]]: header[2] }, body,
    });
    assert.equal(rest.status, 200);
    assert.equal(await rest.text(), s.get('curl-response'));

    const env = { CONDUCTOR_MCP_URL: `${srv.baseUrl}/mcp`, CONDUCTOR_MCP_CLIENT_DIR: projects.mcpClientDir() };
    const py = await python3(s.get('python'), env);
    if (py.err?.code === 'ENOENT') {
      t.diagnostic('python3 not installed — the Python sample was not run');
    } else {
      assert.equal(py.err, null, py.stderr);
      assert.equal(py.stdout.trimEnd(), s.get('python-output'));
    }

    const js = await run(process.execPath, ['--input-type=module', '-e', s.get('node-client')], env);
    assert.equal(js.err, null, js.stderr);
    assert.equal(js.stdout.trimEnd(), s.get('node-client-output'));

    const pyClient = await python3(s.get('python-client'), env);
    if (pyClient.err?.code === 'ENOENT') {
      t.diagnostic('python3 not installed — the Python client sample was not run');
    } else {
      assert.equal(pyClient.err, null, pyClient.stderr);
      assert.equal(pyClient.stdout.trimEnd(), s.get('python-client-output'));
    }
  } finally { await srv.close(); }
});
