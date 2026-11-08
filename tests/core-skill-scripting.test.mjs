// The core skill code-conductor:scripting (claude-plugin/skills/scripting/
// SKILL.md) teaches agents to script cc through run_code. Its one sample is run,
// unchanged, as a live session's run_code body against a server on a fresh
// store. It must report every fixture project's dirty state, and a
// project_status refusal as a digest line rather than a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api, registerLocalProject } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootWithSession, runCodeRest } from './codeModeClient.mjs';
import * as projects from '../src/projects.ts';

const SKILL = path.join(import.meta.dirname, '..', 'claude-plugin', 'skills', 'scripting', 'SKILL.md');

function samples() {
  return [...readFileSync(SKILL, 'utf8').matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
}

// createProject commits its scaffold, so a fresh project is a clean repo.
async function gitProject(srv, name) {
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.gitSkipped, undefined);
  return path.join(srv.projectsRoot, name);
}

test('the scripting skill sample reports each project\'s dirty state through run_code', async () => {
  const js = samples();
  assert.equal(js.length, 1, 'SKILL.md must carry exactly one js sample');

  const { srv, sid } = await bootWithSession({ project: 'host' });
  const plainDir = await mkdtemp('cc-skill-plain-');
  try {
    await gitProject(srv, 'clean');
    const dirty = await gitProject(srv, 'dirty');
    await fs.writeFile(path.join(dirty, 'extra.txt'), 'x\n');
    await registerLocalProject('plain', plainDir);
    // A record on a system the registry does not know: project_status refuses.
    await projects.registerProject('gone', { kind: 'remote', system: 'no-such-system', remoteId: null, path: '/srv/gone' });

    const { body } = await runCodeRest(srv, sid, js[0]);
    assert.equal(body.error, undefined, JSON.stringify(body));
    const names = new Set(['clean', 'dirty', 'gone', 'plain']);
    const digest = JSON.parse(body.result).filter(l => names.has(l.split(':')[0]));
    assert.deepEqual(digest, ['clean: clean', 'dirty: 1 dirty', 'gone: refused SYSTEM_NOT_REGISTERED', 'plain: not a git repo']);
  } finally {
    await srv.close();
  }
});
