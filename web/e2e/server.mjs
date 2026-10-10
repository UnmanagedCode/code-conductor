// Boots the real server for the e2e suite in a throwaway sandbox: temp
// PROJECTS_ROOT and CLAUDE_PROJECTS_ROOT, the fake `claude` CLI playing the
// scenario in e2e/scenario.json, a fixed port (E2E_PORT, default 8799), and a
// git config of its own: the host's global and system config (signing, hooks)
// must not reach the commits the server makes in sandbox projects.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
const projects = path.join(root, 'projects');
const transcripts = path.join(root, 'claude-projects');
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(transcripts, { recursive: true });
const gitconfig = path.join(root, 'gitconfig');
fs.writeFileSync(gitconfig, '[user]\n\tname = e2e\n\temail = e2e@example.invalid\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');

const child = spawn(process.execPath, [path.join(repo, 'server.ts')], {
  cwd: repo,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.E2E_PORT || '8799',
    PROJECTS_ROOT: projects,
    CLAUDE_PROJECTS_ROOT: transcripts,
    CLAUDE_BIN: `${process.execPath} ${path.join(repo, 'tests', 'fake-claude.mjs')}`,
    FAKE_CLAUDE_SCENARIO: path.join(here, 'scenario.json'),
    ANTHROPIC_API_KEY: 'e2e-fake-key',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  },
});

const stop = () => {
  child.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
