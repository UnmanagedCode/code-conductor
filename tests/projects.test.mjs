import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');

test('GET /api/projects returns empty list initially', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  } finally { await close(); }
});

test('POST /api/projects creates a directory and lists it', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    const created = await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'demo');
    assert.equal(created.body.path, path.join(projectsRoot, 'demo'));

    const stat = await fs.stat(path.join(projectsRoot, 'demo'));
    assert.ok(stat.isDirectory());

    const list = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].name, 'demo');
    assert.deepEqual(list.body[0].instanceIds, []);
  } finally { await close(); }
});

test('POST /api/projects seeds CLAUDE.md that imports the workspace-wide one', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'with-md' });
    const mdPath = path.join(projectsRoot, 'with-md', 'CLAUDE.md');
    const text = await fs.readFile(mdPath, 'utf8');
    assert.match(text, /@\.\.\/CLAUDE\.md/, 'imports the parent workspace CLAUDE.md');
  } finally { await close(); }
});

test('POST /api/projects rejects bad names', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    for (const bad of ['', '../escape', 'has space', 'slash/inside', null]) {
      const r = await api(baseUrl, 'POST', '/api/projects', { name: bad });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.match(r.body.error, /invalid project name/);
    }
  } finally { await close(); }
});

test('POST /api/projects conflict on duplicate', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
    const second = await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
    assert.equal(second.status, 409);
  } finally { await close(); }
});

test('encodeCwd replaces every non-alphanumeric char (including dots) with `-`', () => {
  // Regression: real claude writes session jsonls under
  //   ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
  // where every char outside [A-Za-z0-9_-] is replaced with `-`. Previously
  // we only replaced `/`, so cwds like `/data/data/com.termux/...` looked
  // up `…com.termux…` while real claude wrote to `…com-termux…`, and
  // loadHistory/listSessions silently returned empty.
  assert.equal(
    encodeCwd('/data/data/com.termux/files/home/project/Testapp'),
    '-data-data-com-termux-files-home-project-Testapp',
  );
  assert.equal(encodeCwd('/foo bar/baz'), '-foo-bar-baz');
  assert.equal(encodeCwd('/a/b_c-d/e.f'), '-a-b_c-d-e-f');
});

test('GET /api/projects/:name/sessions reads jsonl headers', async () => {
  const { baseUrl, projectsRoot, claudeProjectsRoot, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
    const sessDir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'sess')));
    await fs.mkdir(sessDir, { recursive: true });
    const sid = 'abcdef01-2345-6789-abcd-ef0123456789';
    await fs.copyFile(FIXTURE_JSONL, path.join(sessDir, `${sid}.jsonl`));

    const r = await api(baseUrl, 'GET', '/api/projects/sess/sessions');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].sessionId, sid);
    assert.match(r.body[0].firstPrompt, /hello from fixture/);
    assert.ok(r.body[0].mtime > 0);
    assert.ok(r.body[0].size > 0);
  } finally { await close(); }
});

test('GET /api/projects/:name/sessions returns [] when no session dir', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'empty' });
    const r = await api(baseUrl, 'GET', '/api/projects/empty/sessions');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  } finally { await close(); }
});

test('GET /api/projects/:name/sessions 404s unknown project', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/projects/nope/sessions');
    assert.equal(r.status, 404);
  } finally { await close(); }
});
