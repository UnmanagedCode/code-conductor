// docs/mcp-applications.md's samples are the server's real bytes: each marked
// block (`<!-- doc-sample: NAME -->` + a fenced block) is replayed, in order,
// against a live server on a fresh store, and the documented response must be
// exactly what comes back. The JSON-RPC request is POSTed as written; the curl
// line is parsed (URL, header, body) and replayed via fetch; the Python sample
// runs under `python3 -I -B` with CONDUCTOR_MCP_URL pointing at the server, and
// is skipped with a log when no python3 is installed. docs/code-mode.md's
// samples are replayed too, as a live session's run_code calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { bootServer } from './helpers.mjs';
import { bootWithSession, runCodeRest } from './codeModeClient.mjs';

const DOC = path.join(import.meta.dirname, '..', 'docs', 'mcp-applications.md');
const CODE_MODE_DOC = path.join(import.meta.dirname, '..', 'docs', 'code-mode.md');
const DOC_BASE = 'http://127.0.0.1:8787';

function samples(file = DOC) {
  const out = new Map();
  const re = /<!-- doc-sample: ([\w-]+) -->\n```\w*\n([\s\S]*?)\n```/g;
  for (const m of readFileSync(file, 'utf8').matchAll(re)) out.set(m[1], m[2]);
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
  for (const name of ['rpc-request', 'rpc-response', 'curl', 'curl-response', 'python', 'python-output']) {
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

    const env = { CONDUCTOR_MCP_URL: `${srv.baseUrl}/mcp` };
    const py = await python3(s.get('python'), env);
    if (py.err?.code === 'ENOENT') {
      t.diagnostic('python3 not installed — the Python sample was not run');
    } else {
      assert.equal(py.err, null, py.stderr);
      assert.equal(py.stdout.trimEnd(), s.get('python-output'));
    }
  } finally { await srv.close(); }
});

test('every docs/code-mode.md sample replays to its documented result', async () => {
  const s = samples(CODE_MODE_DOC);
  const pairs = [['run-code', 'run-code-result'], ['describe-names', 'describe-names-result']];
  for (const [code, result] of pairs) {
    assert.ok(s.has(code) && s.has(result), `docs/code-mode.md lost its '${code}' / '${result}' samples`);
  }
  const { srv, sid } = await bootWithSession();
  try {
    for (const [code, result] of pairs) {
      const { body } = await runCodeRest(srv, sid, s.get(code));
      assert.equal(body.error, undefined, JSON.stringify(body));
      assert.equal(body.result, JSON.stringify(JSON.parse(s.get(result))), `${code} → ${result}`);
    }
  } finally { await srv.close(); }
});
