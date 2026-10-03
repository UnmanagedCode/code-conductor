import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGit, detectClaude, launcherEnv, addToUserPath, findOnPath } from '../installer/windows/toolchain.mjs';

const existsIn = (...files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};
const USER = 'C:\\Users\\Jo Bloggs';

test('detectGit: PATH hit with bash.exe', () => {
  const g = 'C:\\Git\\cmd\\git.exe';
  const r = detectGit({ PATH: 'C:\\x;C:\\Git\\cmd' }, existsIn(g, 'C:\\Git\\bin\\bash.exe'));
  assert.deepEqual(r, { gitExe: g, cmdDir: 'C:\\Git\\cmd' });
});

test('detectGit: falls back to the per-user install, then Program Files', () => {
  const local = `${USER}\\AppData\\Local\\Programs\\Git`;
  const r = detectGit({ PATH: '', LOCALAPPDATA: `${USER}\\AppData\\Local`, ProgramFiles: 'C:\\Program Files' },
    existsIn(`${local}\\cmd\\git.exe`, `${local}\\bin\\bash.exe`));
  assert.equal(r.gitExe, `${local}\\cmd\\git.exe`);
  const pf = detectGit({ PATH: '', ProgramFiles: 'C:\\Program Files' },
    existsIn('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'));
  assert.equal(pf.cmdDir, 'C:\\Program Files\\Git\\cmd');
});

test('detectGit: git without bash.exe is treated as absent', () => {
  assert.equal(detectGit({ PATH: 'C:\\Git\\cmd' }, existsIn('C:\\Git\\cmd\\git.exe')), null);
});

test('detectGit: a bashless PATH git does not mask a complete per-user one', () => {
  const local = 'C:\\L\\Programs\\Git';
  const r = detectGit({ Path: 'C:\\Bare', LOCALAPPDATA: 'C:\\L' },
    existsIn('C:\\Bare\\git.exe', `${local}\\cmd\\git.exe`, `${local}\\bin\\bash.exe`));
  assert.equal(r.gitExe, `${local}\\cmd\\git.exe`);
});

test('detectClaude: .cmd shim rejected, .local\\bin fallback used', () => {
  const exe = `${USER}\\.local\\bin\\claude.exe`;
  assert.equal(detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd')), null);
  const r = detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd', exe));
  assert.deepEqual(r, { claudeExe: exe, dir: `${USER}\\.local\\bin` });
});

test('findOnPath: case-insensitive PATH key', () => {
  assert.equal(findOnPath('git', { pAtH: 'C:\\a;C:\\b' }, existsIn('C:\\b\\git.exe')), 'C:\\b\\git.exe');
});

test('launcherEnv: PATH order, case-insensitive dedupe, spaces preserved', () => {
  const inst = `${USER}\\AppData\\Local\\Programs\\code-conductor`;
  const git = { gitExe: 'C:\\Git\\cmd\\git.exe', cmdDir: 'C:\\Git\\cmd' };
  const claude = { claudeExe: `${USER}\\.local\\bin\\claude.exe`, dir: `${USER}\\.local\\bin` };
  const env = launcherEnv({
    env: { Path: `C:\\Windows;c:\\git\\cmd;${USER}\\.local\\bin`, USERPROFILE: USER },
    installDir: inst, git, claude,
  });
  assert.equal(env.Path, [`${inst}\\node`, 'C:\\Git\\cmd', `${USER}\\.local\\bin`, 'C:\\Windows'].join(';'));
  assert.equal(env.PATH, undefined);
  assert.equal(env.PROJECTS_ROOT, `${USER}\\code-conductor`);
});

test('launcherEnv: PROJECTS_ROOT override kept, no CLAUDE_BIN/HOST/PORT/GIT_BASH injected', () => {
  const env = launcherEnv({
    env: { PATH: 'C:\\W', USERPROFILE: USER, PROJECTS_ROOT: 'D:\\work' },
    installDir: 'C:\\i', git: null, claude: null,
  });
  assert.equal(env.PROJECTS_ROOT, 'D:\\work');
  for (const k of ['CLAUDE_BIN', 'HOST', 'PORT', 'CLAUDE_CODE_GIT_BASH_PATH']) assert.equal(env[k], undefined);
});

function fakeReg(initial) {
  const calls = [];
  let value = initial;
  return {
    calls,
    get value() { return value; },
    reg: async (args) => {
      calls.push(args);
      if (args[0] === 'query') {
        return value === null ? { code: 1, stdout: '' }
          : { code: 0, stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${value}\r\n\r\n` };
      }
      value = args[args.indexOf('/d') + 1];
      return { code: 0, stdout: '' };
    },
  };
}

test('addToUserPath: appends once, keeps %VAR%, REG_EXPAND_SZ', async () => {
  const f = fakeReg('%USERPROFILE%\\bin;C:\\Tools');
  const dir = `${USER}\\.local\\bin`;
  assert.equal(await addToUserPath(dir, { reg: f.reg, env: { USERPROFILE: USER } }), true);
  assert.equal(f.value, `%USERPROFILE%\\bin;C:\\Tools;${dir}`);
  const add = f.calls.find((c) => c[0] === 'add');
  assert.equal(add[add.indexOf('/t') + 1], 'REG_EXPAND_SZ');
  assert.equal(await addToUserPath(dir, { reg: f.reg, env: { USERPROFILE: USER } }), false);
});

test('addToUserPath: recognises an existing %VAR% or differently-cased entry', async () => {
  const dir = `${USER}\\.local\\bin`;
  for (const existing of ['%USERPROFILE%\\.local\\bin', dir.toUpperCase() + '\\']) {
    const f = fakeReg(`C:\\a;${existing}`);
    assert.equal(await addToUserPath(dir, { reg: f.reg, env: { USERPROFILE: USER } }), false);
    assert.equal(f.calls.some((c) => c[0] === 'add'), false);
  }
});

test('addToUserPath: no existing Path value is created; a long Path is not truncated', async () => {
  const f = fakeReg(null);
  await addToUserPath('C:\\n', { reg: f.reg, env: {} });
  assert.equal(f.value, 'C:\\n');
  const long = Array.from({ length: 300 }, (_, i) => `C:\\dir${i}`).join(';');
  const g = fakeReg(long);
  await addToUserPath('C:\\n', { reg: g.reg, env: {} });
  assert.equal(g.value, `${long};C:\\n`);
});
