// Integration tests for spawn_instance's optional `title`: a conductor names a
// worker at spawn through the same write as set_session_title and the Rename
// route (applySessionTitle, src/sessionTitles.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, waitFor, instForSession, seedSessionJsonl, registerLocalProject } from './helpers.mjs';
import { MAX_TITLE_LEN } from '../src/sessionTitles.ts';
import { getTitle, loadSessions } from '../src/sessionStore.ts';
import { localPlace } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

async function makeRepo(projectsRoot, name) {
  const repo = path.join(projectsRoot, name);
  await fs.mkdir(repo, { recursive: true });
  await registerLocalProject(name, repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'README.md'), '# test\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

async function titledRecords() {
  return [...(await loadSessions()).byPublic].filter(([, rec]) => rec.title !== undefined);
}

let nextRpcId = 1;
async function callToolRaw(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp?format=text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
// The JSON format carries a refusal as a JSON-RPC error whose data holds the code.
async function callToolJson(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.json();
}
async function callTool(baseUrl, name, args) {
  const result = await callToolRaw(baseUrl, name, args);
  assert.ok(!result.isError, `tools/call ${name} errored: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function withServer(fn) {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    const repo = await makeRepo(srv.projectsRoot, 'demo');
    await fn(srv, repo);
  } finally { await srv.close(); }
}

async function killAndSeed(srv, sessionId) {
  const inst = instForSession(srv.instances, sessionId);
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId);
  await callTool(srv.baseUrl, 'kill_instance', { sessionId });
  await waitFor(() => !instForSession(srv.instances, sessionId)?.proc);
}

test('a spawn with a title stores it trimmed on the record, the live instance and every read surface', async () => {
  // Pins: the title lands via applySessionTitle — result, store record, live
  // instance, list_sessions and describe_session all agree.
  await withServer(async srv => {
    const w = await callTool(srv.baseUrl, 'spawn_instance', { project: 'demo', title: '  Auth refactor  ' });
    assert.equal(w.title, 'Auth refactor');
    assert.equal(await getTitle(w.sessionId), 'Auth refactor');
    assert.equal((await loadSessions()).byPublic.get(w.sessionId)?.title, 'Auth refactor');
    assert.equal(instForSession(srv.instances, w.sessionId).title, 'Auth refactor');
    const listed = await callToolRaw(srv.baseUrl, 'list_sessions', { project: 'demo' });
    assert.ok(listed.content[0].text.includes('Auth refactor'), 'list_sessions shows the title');
    const described = await callToolRaw(srv.baseUrl, 'describe_session', { sessionId: w.sessionId });
    assert.ok(described.content[0].text.includes('Auth refactor'), 'describe_session shows the title');
  });
});

test('a title is durable when the worker is killed before it is ever prompted', async () => {
  // Pins: the record exists from mint, so the write precedes the conductor's
  // result and survives an immediate exit.
  await withServer(async srv => {
    const w = await callTool(srv.baseUrl, 'spawn_instance', { project: 'demo', title: 'Early exit' });
    await callTool(srv.baseUrl, 'kill_instance', { sessionId: w.sessionId });
    await waitFor(() => !instForSession(srv.instances, w.sessionId)?.proc);
    assert.equal(await getTitle(w.sessionId), 'Early exit');
  });
});

for (const [label, title] of [['empty', ''], ['whitespace-only', ' \t '], ['over-long', 'x'.repeat(MAX_TITLE_LEN + 1)]]) {
  test(`an ${label} title is refused before any side effect: no worker, no titled record, no worktree`, async () => {
    // Pins: ARGS_INVALID (JSON-RPC error data.code) comes from the schema, ahead of worktree creation and create().
    await withServer(async (srv, repo) => {
      const liveBefore = srv.instances.list().length;
      const wtBefore = await git(repo, 'worktree', 'list');
      const res = await callToolRaw(srv.baseUrl, 'spawn_instance', { project: 'demo', createWorktree: true, title });
      assert.equal(res.isError, true, JSON.stringify(res));
      const json = await callToolJson(srv.baseUrl, 'spawn_instance', { project: 'demo', createWorktree: true, title });
      assert.equal(json.error?.data?.code, 'ARGS_INVALID', JSON.stringify(json));
      assert.equal(srv.instances.list().length, liveBefore);
      assert.deepEqual(await titledRecords(), []);
      assert.equal(await git(repo, 'worktree', 'list'), wtBefore);
    });
  });
}

test('a spawn without a title leaves the store untitled and the result title null', async () => {
  // Pins: absence of `title` changes nothing.
  await withServer(async srv => {
    const w = await callTool(srv.baseUrl, 'spawn_instance', { project: 'demo' });
    assert.equal(w.title ?? null, null);
    assert.deepEqual(await titledRecords(), []);
  });
});

test('resume with a title retitles the session, and a later bare resume keeps it', async () => {
  // Pins: title + resume is a retitle (like the other two writers); a bare resume writes nothing.
  await withServer(async srv => {
    const w = await callTool(srv.baseUrl, 'spawn_instance', { project: 'demo', title: 'A' });
    await killAndSeed(srv, w.sessionId);
    const back = await callTool(srv.baseUrl, 'spawn_instance', { resume: w.sessionId, title: 'B' });
    assert.equal(back.sessionId, w.sessionId);
    assert.equal(back.title, 'B');
    assert.equal(await getTitle(w.sessionId), 'B');
    assert.equal(instForSession(srv.instances, w.sessionId).title, 'B');
    await killAndSeed(srv, w.sessionId);
    const again = await callTool(srv.baseUrl, 'spawn_instance', { resume: w.sessionId });
    assert.equal(again.title, 'B');
    assert.equal(await getTitle(w.sessionId), 'B');
  });
});

test('a refused resume writes no title', async () => {
  // Pins: the title is written only after create() succeeds.
  await withServer(async srv => {
    const res = await callTool(srv.baseUrl, 'spawn_instance', { project: 'demo', resume: 'bogus-session-id', title: 'X' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_UNKNOWN');
    assert.deepEqual(await titledRecords(), []);
  });
});
