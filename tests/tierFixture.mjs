// ONE fixture for the session tier table, shared by every test that needs a
// `SessionRedirect`.
//
// It calls the PRODUCT's `buildTierTable`, never a transcribed array: the whole
// point of the artifact is that the hook's deny surface and the daemon's pins
// come out of one function, and a fixture that hand-wrote a table would let a
// derivation change pass unnoticed in exactly the tests that read it.
//
// Every field is overridable, so a test can vary the one input it is about.

import { buildTierTable } from '../src/systems/fuse/tierTable.ts';

export const FIXTURE_LOCAL_ROOTS = [
  { prefix: '/store/attachments/app', access: 'allow', why: "this project's upload channel" },
  { prefix: '/store/session-tmp/inst-1', access: 'allow', why: "this session's own tmp dir" },
  { prefix: '/home/wk/.claude/plans', access: 'allow', why: 'plan mode writes its plan file here' },
  { prefix: '/home/wk/.claude', access: 'deny', why: "the CLI's own settings and credentials" },
  { prefix: '/home/wk/.claude/projects', access: 'deny', why: "every session on this machine's transcripts" },
];

export function tierFixtureInput(over = {}) {
  return {
    localRoots: FIXTURE_LOCAL_ROOTS,
    claudeCommand: '/usr/local/share/npm-global/bin/claude',
    execPath: '/usr/local/bin/node',
    selfProjectDir: '/home/wk/cc',
    projectsRoot: '/home/wk/cc-projects',
    homeDir: '/home/wk',
    runDir: '/home/wk/cc-projects/.cc-store/systems/fuse/run/inst-1',
    systemPath: '/srv/app',
    mirrorRoot: '/srv/app',
    exclude: [],
    ...over,
  };
}

export function sessionTiers(over = {}) {
  return buildTierTable(tierFixtureInput(over));
}

// The three options `SessionRedirect` needs to classify a file path, built from
// one geometry so a caller cannot hand it a table and a mirror root that
// disagree.
export function redirectTierOptions({ systemPath, mirrorRoot = systemPath, exclude = [], localRoots } = {}) {
  const over = { systemPath, mirrorRoot, exclude, ...(localRoots ? { localRoots } : {}) };
  return { tiers: sessionTiers(over), exclude, mirrorRoot };
}
