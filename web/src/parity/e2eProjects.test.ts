// @vitest-environment node
// Which Playwright project runs which spec, read from Playwright's own listing
// of web/playwright.config.ts (no browser, no globalSetup): an
// `*.android.spec.ts` twin runs on android alone, its desktop spec everywhere else.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const E2E = path.join(ROOT, 'web/e2e');

type Suite = { specs: { file: string; tests: { projectName: string }[] }[]; suites?: Suite[] };
type Listing = { suites: Suite[]; errors: { message?: string }[] };

/** Per project, every spec file (relative to web/e2e) it lists a test of. */
function listedFiles(): Record<string, Set<string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pw-list-'));
  const out = path.join(dir, 'list.json');
  try {
    execFileSync('npx', ['playwright', 'test', '--config', 'web/playwright.config.ts', '--list', '--reporter=json'], {
      cwd: ROOT, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out, NO_COLOR: '1' }, stdio: 'pipe', timeout: 60_000,
    });
    const listing = JSON.parse(fs.readFileSync(out, 'utf8')) as Listing;
    expect(listing.errors.map((e) => e.message)).toEqual([]);
    const by: Record<string, Set<string>> = {};
    const walk = (s: Suite) => {
      for (const spec of s.specs) for (const t of spec.tests) (by[t.projectName] ??= new Set()).add(spec.file);
      for (const child of s.suites ?? []) walk(child);
    };
    listing.suites.forEach(walk);
    return by;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

it('the android project runs every *.android.spec.ts twin and none of their desktop specs; desktop and phone run every desktop spec and no twin', () => {
  // Invariant: the projects' testMatch/testIgnore split each twin pair between android and the other two.
  const twins = fs.readdirSync(E2E, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.android.spec.ts')).sort();
  expect(twins.length).toBeGreaterThan(0);
  const desktopSpecs = twins.map((f) => f.replace(/\.android\.spec\.ts$/, '.spec.ts'));
  for (const f of desktopSpecs) expect(fs.existsSync(path.join(E2E, f)), `${f} beside its twin`).toBe(true);
  const by = listedFiles();
  const listed = (project: string, files: string[]) => files.filter((f) => by[project]?.has(f) ?? false);
  expect(listed('android', twins)).toEqual(twins);
  expect(listed('android', desktopSpecs)).toEqual([]);
  for (const project of ['desktop', 'phone']) {
    expect(listed(project, desktopSpecs), project).toEqual(desktopSpecs);
    expect(listed(project, twins), project).toEqual([]);
  }
}, 60_000);
