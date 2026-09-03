// src/systems/bashForwarder.ts — the SECOND hop of the chain, and the first test
// of any kind for that script.
//
// It has to be SPAWNED rather than imported: it is a top-level-side-effect
// module (it reads process.argv and issues its request at load), so importing it
// would run it against this file's own argv. That is also what it is in
// production — the CLI spawns it with process.execPath as argv[0] — so spawning
// is the faithful shape, not a workaround.
//
// GREEN ON ARRIVAL. Card 2026-0305 changed what ProviderShell does with the
// number the forwarder carries, not how it carries it. The hop is pinned here
// because after that card the tool timeout no longer changes any run outcome, so
// the request BODY is the only place `--timeout` is observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORWARDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systems', 'bashForwarder.ts',
);

// One request, answered with a single terminal frame, and the body handed back.
// NDJSON with a trailing newline, exactly as src/routes.ts writes it.
async function forward(args) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(raw);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ t: 'out', text: 'ok' })}\n${JSON.stringify({ t: 'exit', code: 0 })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/instances/x/bash-forward`;
  try {
    const ran = await new Promise((resolve) => {
      const child = spawn(process.execPath, [FORWARDER, '--url', url, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (b) => { stdout += b; });
      child.stderr.on('data', (b) => { stderr += b; });
      child.on('close', (code) => resolve({ stdout, stderr, code }));
    });
    return { ran, body: bodies.length === 1 ? JSON.parse(bodies[0]) : bodies };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// INVERTED on card 2026-0312 §2 D-b: `--timeout` used to become `timeoutMs` on
// the request body. Neither the flag nor the key exists any more — its only
// consumer was the wait bound on a queue that is gone, and the CLI enforces its
// own tool timeout by KILLING this process, which closes the socket. That is
// cc's cancellation channel and it carries no number.
//
// ASSERTED AS AN EXACT BODY SHAPE, not just an absent key: this is the layer
// that decides what goes on the wire, so an extra field re-appearing here is
// what this catches.
test('the body carries the command and nothing else', async () => {
  const r = await forward(['--', 'echo hi']);
  assert.equal(r.ran.code, 0, r.ran.stderr);
  assert.equal(r.ran.stdout, 'ok');
  assert.deepEqual(r.body, { command: 'echo hi' });
});

// PINS: `--agent` rides the same way, and the MAIN agent's invocation carries
// no key at all — a forwarder invocation and a body without it must mean the
// same thing, because that is what src/routes.ts keys the main agent's shell on.
test('--agent becomes agentId on the wire, and the main agent sends no key', async () => {
  const sub = await forward(['--agent', 'a1', '--', 'echo hi']);
  assert.deepEqual(sub.body, { command: 'echo hi', agentId: 'a1' });

  const main = await forward(['--', 'echo hi']);
  assert.equal('agentId' in main.body, false);
});

// PINS: the command survives as ONE argv element past `--`, spaces, quotes and
// all. That is the whole reason the forwarder is a separate process rather than
// a shell one-liner — no quoting of the original command survives into a second
// shell.
test('everything past -- is the command, verbatim', async () => {
  const { body } = await forward(['--agent', 'a1', '--', `echo 'it\\'s here' && ls "a b"`]);
  assert.equal(body.command, `echo 'it\\'s here' && ls "a b"`);
  assert.equal(body.agentId, 'a1');
});
