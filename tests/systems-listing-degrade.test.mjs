// THE LISTING GUARANTEE: one bad project record must never break the list for
// every other project.
//
// listProjects() already commits to this for its own enumeration — a broken
// `.external` link "is skipped, not fatal: the rest of the project list must
// still render". Its ENRICHMENT layer did not: every listing fans its
// per-project work out through ONE `Promise.all`, and each of the three sites
// below called `resolveSystem` inside it unguarded. A single project whose
// record names a system cc cannot reach therefore rejected the whole batch —
// the sidebar and Projects UI broke wholesale, `list_projects` failed for every
// project, and `list_sessions` (whose unfiltered scope spans every project)
// failed too.
//
// The refusal itself is CORRECT and stays: resolving such a project to `local`
// would run its operations against a path on the wrong machine and report
// success. What these pin is that the refusal stays SCOPED to the project it
// concerns. The affected row is kept, not dropped — a project that vanishes
// from the sidebar is indistinguishable from a deleted one — with its git facts
// ABSENT rather than measured, plus `systemUnreachable` naming the reason.
//
// The project that triggers this is an ordinary remote project: a record
// placing it on a system, which is the only registration a remote project has.
// What makes the system unreachable here is that no registry row exists for it
// at all — the cheapest of the several ways cc can fail to reach one, and the
// one whose refusal every listing has to survive.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { projectStoreDir, projectsRoot, createProject } from '../src/projects.ts';

const REMOTE = { system: 'prod-box', systemPath: '/app' };

async function writeRecord(name, record) {
  const dir = projectStoreDir(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(record, null, 2) + '\n');
}

// One unreachable project sitting BETWEEN two healthy ones, so a listing that
// aborts on the first refusal and one that drops the row are both caught.
//
// `withSessions` seeds one transcript per project: list_sessions drops an EMPTY
// group from an unfiltered listing before it ever computes a branch, so its
// resolveSystem call — site 3 — is only reachable for a project that has one.
// The transcript is keyed off the project's own tree path, which for `beta` is
// the path on its system: the CLI encodes its session directory from the cwd it
// ran in, and cc has only one such path per project.
async function seedThree({ withSessions = false } = {}) {
  const treeOf = (name) => (name === 'beta' ? REMOTE.systemPath : path.join(projectsRoot(), name));
  for (const name of ['alpha', 'gamma']) await createProject(name);
  // `beta` is registered by its record alone — a remote project has no
  // directory under the projects root and no `.external` link.
  await writeRecord('beta', REMOTE);
  if (withSessions) {
    for (const name of ['alpha', 'beta', 'gamma']) {
      await seedSessionJsonl(process.env.CLAUDE_PROJECTS_ROOT, treeOf(name), `sid-${name}`);
    }
  }
}

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  assert.ok(!body.result.isError, `tools/call ${name} errored: ${JSON.stringify(body.result)}`);
  return body.result.content[0].text;
}

describe('a project on an unreachable system degrades its own row only', () => {
  let ctx, baseUrl, home;
  before(async () => { ctx = await bootServer(); baseUrl = ctx.baseUrl; });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

  // SITE 1 — GET /api/projects (computeGitFacts inside the route's Promise.all).
  test('GET /api/projects still returns EVERY project', async () => {
    await seedThree();
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map(p => p.name), ['alpha', 'beta', 'gamma'],
      'the unreachable project neither aborts the listing nor disappears from it');

    const beta = r.body.find(p => p.name === 'beta');
    assert.match(beta.systemUnreachable, /prod-box/, 'the row says WHY its facts are missing');
    assert.equal(beta.system, 'prod-box');
    assert.equal(beta.systemPath, '/app');
    // Absent, not `false`: "could not look" must not be served as the positive
    // claim "not a git repo". Absent is falsy, which is all any client does with it.
    assert.equal('isGitRepo' in beta, false, 'no measured git fact is invented');
    assert.deepEqual(beta.mergeStatus, { ahead: null, behind: null, upstream: null });

    // The healthy rows are untouched — same shape as before the bad record existed.
    for (const name of ['alpha', 'gamma']) {
      const p = r.body.find(x => x.name === name);
      assert.equal(p.systemUnreachable, null);
      assert.equal(p.isGitRepo, true, `${name} is still measured`);
      assert.equal(p.system, 'local');
    }
  });

  // SITE 2 — MCP list_projects (its own Promise.all over the same projects).
  test('list_projects renders every project, and never claims the bad one is not a repo', async () => {
    await seedThree();
    const text = await callTool(baseUrl, 'list_projects', {});
    assert.match(text, /PROJECTS \(3\)/);
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.match(text, new RegExp(`▸ ${name}\\b`), `${name} is listed`);
    }
    assert.match(text, /! system unreachable .*prod-box/, 'the reason is in the text');
    assert.match(text, /system prod-box/);
    assert.match(text, /systemPath \/app/);
    // The one thing a degraded row must not do is assert a fact it never measured.
    assert.ok(!text.includes('! not a git repo'),
      'an unmeasurable project must not print the positive claim "not a git repo"');
  });

  // SITE 3 — MCP list_sessions. Its UNFILTERED scope spans every project, so
  // this is the tool a conductor uses to find its own session.
  test('list_sessions renders every group, the bad one with an unknown branch', async () => {
    await seedThree({ withSessions: true });
    const text = await callTool(baseUrl, 'list_sessions', {});
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.match(text, new RegExp(`\\b${name}\\b`), `${name}'s group is listed`);
      assert.match(text, new RegExp(`sid-${name}\\b`), `${name}'s session is still reachable`);
    }
    // Each project's block runs from its `▸ <name>` header to the next one.
    const blockFor = (name) => text.split('▸ ').find(b => b.startsWith(name + ' '));
    // groupGit's own "not measured" vocabulary, rendered by dash() — an unknown
    // branch, not a failed tool call.
    assert.match(blockFor('beta'), /main checkout {2}br —/,
      "the unreachable project's branch reads as unknown");
    for (const name of ['alpha', 'gamma']) {
      assert.match(blockFor(name), /main checkout {2}br master/, `${name} is still measured`);
    }
  });

  // The refusal is still a refusal where the caller asked about THAT project.
  test('an addressed-by-name call on the same project still refuses', async () => {
    await seedThree();
    const r = await api(baseUrl, 'GET', '/api/projects/beta/sessions');
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(r.body.error, /prod-box/);
  });
});
