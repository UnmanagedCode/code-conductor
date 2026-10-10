// The mutation harness's test command: runs the named test files through their
// own runners and prints one framed, bounded section per runner for parse.mjs.
// It only RUNS things; routing, commands and report reduction are scoring.ts.
//
//   node harness/mutation/suite.ts --all              typecheck, whole node suite, whole Vitest suite
//   node harness/mutation/suite.ts <test file>...     those files only, never a typecheck
//
// Playwright rows run under ONE project, CC_MUTATION_PW_PROJECT (default
// desktop), printed in the playwright section header so the stored report says
// which. Exit 2 (stderr says why, stdout stays empty) on anything it refuses: a
// non-test file, an unknown project, a requested file its runner did not run.
// Otherwise exit 0 only if every runner did.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  frame, planCommands, playwrightReportFiles, playwrightScopeRefusal, pwProject, reducePlaywrightReport, reduceVitestReport, route,
  vitestScopeRefusal,
  type Command, type Group,
} from './scoring.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW_CONFIG = path.join(REPO_ROOT, 'web', 'playwright.config.ts');
const TAIL_BYTES = 16 * 1024;

class Refusal extends Error {}

type Run = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code: code ?? (signal ? 128 : 1),
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

const tail = (text: string): string => {
  const buf = Buffer.from(text);
  return buf.length <= TAIL_BYTES ? text : buf.subarray(buf.length - TAIL_BYTES).toString('utf8');
};

function readReport<T>(file: string | undefined): T | null {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

async function playwrightProjects(): Promise<string[]> {
  const config = (await import(pathToFileURL(PW_CONFIG).href)).default as { projects?: Array<{ name?: string }> };
  return (config.projects ?? []).map((p) => p.name ?? '');
}

type PwReport = Parameters<typeof playwrightReportFiles>[0];

/** `playwright test --list` for one project and file: the report scoring.ts reads, or null. */
async function listReport(project: string, file: string, tmpDir: string): Promise<PwReport | null> {
  const report = path.join(tmpDir, `list-${project}.json`);
  await run('npx', ['playwright', 'test', '--config', 'web/playwright.config.ts', `--project=${project}`, '--list', '--reporter=json', file],
    { PLAYWRIGHT_JSON_OUTPUT_FILE: report, NO_COLOR: '1' });
  const r = readReport<PwReport>(report);
  fs.rmSync(report, { force: true });
  return r;
}

async function section(c: Command, r: Run, project: string, projects: string[], tmpDir: string): Promise<string> {
  if (c.group === 'typecheck') return frame(`typecheck exit=${r.code}`, r.code ? tail(r.stdout + r.stderr) : '');
  if (c.group === 'node') return frame(`node-stdout exit=${r.code}`, r.stdout) + frame('node-stderr', r.stderr);

  if (c.group === 'vitest') {
    const report = readReport<Parameters<typeof reduceVitestReport>[0]>(c.report);
    if (!report) return frame(`vitest-stderr-tail exit=${r.code}`, tail(r.stderr));
    const reduced = reduceVitestReport(report, REPO_ROOT, c.files);
    const refusal = vitestScopeRefusal(reduced, c.files);
    if (refusal) throw new Refusal(refusal);
    return frame(`vitest exit=${r.code}`, JSON.stringify(reduced));
  }

  const report = readReport<Parameters<typeof reducePlaywrightReport>[0]>(c.report);
  if (!report) return frame(`playwright-stderr-tail project=${project} exit=${r.code}`, tail(r.stderr));
  const reduced = reducePlaywrightReport(report, REPO_ROOT, c.files, project);
  for (const f of playwrightReportFiles(report, REPO_ROOT)) {
    if (!fs.existsSync(path.join(REPO_ROOT, f))) throw new Refusal(`Playwright reported ${f}, which does not exist`);
  }
  const refusal = await playwrightScopeRefusal({
    requested: c.files, report, repoRoot: REPO_ROOT, project, projects, list: (p, f) => listReport(p, f, tmpDir),
  });
  if (refusal) throw new Refusal(refusal);
  return frame(`playwright project=${project} exit=${r.code}`, JSON.stringify(reduced));
}

async function main(argv: string[]): Promise<number> {
  const all = argv[0] === '--all';
  if (all ? argv.length !== 1 : argv.length === 0) {
    throw new Refusal('usage: node harness/mutation/suite.ts --all | <test file>...');
  }
  const project = pwProject(process.env);
  const projects = await playwrightProjects();
  let groups: Map<Group, string[]>;
  try { groups = all ? new Map() : route(argv, REPO_ROOT); }
  catch (e) { throw new Refusal((e as Error).message); }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mutation-suite-'));
  try {
    let commands: Command[];
    try { commands = planCommands(all ? 'all' : 'narrow', groups, { project, projects, tmpDir }); }
    catch (e) { throw new Refusal((e as Error).message); }
    // Buffered and printed only once every runner is done, so a refusal leaves
    // stdout empty and reads as zero tests rather than as a partial result.
    let out = '';
    let ok = true;
    for (const c of commands) {
      const r = await run(c.cmd, c.args, c.env);
      if (r.code !== 0) ok = false;
      out += await section(c, r, project, projects, tmpDir);
    }
    process.stdout.write(out);
    return ok ? 0 : 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  process.stderr.write(`harness/mutation/suite.ts: ${e.message.replace(/^harness\/mutation\/suite\.ts: /, '')}\n`);
  process.exitCode = 2;
}
