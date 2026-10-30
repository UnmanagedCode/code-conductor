// GET /api/terminal ON cc's OWN MACHINE (src/hostTerminal.ts): the shared rows
// of tests/hostTerminalRows.mjs against the `local` system, addressed by
// project, by project + worktree, and by system + cwd.
//
// GATE-AWARE. Under `npm run gate:systems` the `local` system is a provider, and
// in the `--no-pty` configuration it has no terminals: there every row that
// needs one asserts the 501 refusal that configuration owes instead
// (expectedLocalTerminalRefusal, tests/terminalBattery.mjs).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { createWorktree } from '../src/worktrees.ts';
import { LOCAL_SYSTEM_ID, disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { HOST_TERMINAL_ROWS, refused } from './hostTerminalRows.mjs';
import { expectedLocalTerminalRefusal } from './terminalBattery.mjs';

describe('GET /api/terminal on the local system', () => {
  let ctx, home, scratch, env;

  before(async () => { ctx = await bootServer(); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    const repo = await fs.realpath(await seedRepo(path.join(process.env.PROJECTS_ROOT, 'demo')));
    await registerLocalProject('demo', repo);
    const wt = await createWorktree('demo', { name: 'feature' });
    scratch = await fs.realpath(await mkdtemp('cc-host-terminal-'));
    const target = { system: LOCAL_SYSTEM_ID, cwd: scratch };
    env = {
      baseUrl: ctx.baseUrl, cwd: scratch, target, noPtyTarget: null,
      forms: [
        { name: 'project', target: { project: 'demo' }, cwd: repo },
        { name: 'project + worktree', target: { project: 'demo', worktree: wt.worktreeName }, cwd: await fs.realpath(wt.worktreePath) },
        { name: 'system + cwd', target, cwd: scratch },
      ],
      assertNothingOpened: async () => {},
    };
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(scratch);
    await rmrf(home);
  });

  for (const row of HOST_TERMINAL_ROWS) {
    test(row.name, async () => {
      if (row.needsPty) {
        const sys = await systemById(LOCAL_SYSTEM_ID, null, 'the host terminal route test');
        if (typeof sys.connect === 'function') await sys.connect();
        const refusal = expectedLocalTerminalRefusal(sys);
        if (refusal !== null) {
          // This configuration has no terminals: the endpoint says so by name.
          const r = await refused(env.baseUrl, { ...env.target, cols: 80, rows: 24, argv: ['cat'] });
          assert.equal(r.status, 501, JSON.stringify(r.body));
          assert.equal(r.body.code, refusal);
          return;
        }
      }
      await row.fn(env);
    });
  }
});
