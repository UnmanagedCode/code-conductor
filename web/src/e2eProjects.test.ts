// @vitest-environment node
// Which Playwright project runs which spec, read from Playwright's own listing
// of web/playwright.config.ts (no browser, no globalSetup): android runs the
// specs ANDROID_SPECS names as they are, plus its `*.android.spec.ts` overrides,
// which replace their desktop spec on android alone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ANDROID_SPECS } from '../playwright.config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

it('android runs ANDROID_SPECS, the overrides, harness and flows; desktop and phone run every desktop spec and no override', () => {
  const overrides = fs.readdirSync(E2E, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.android.spec.ts')).sort();
  // Invariant: the override loop below can never run empty.
  expect(overrides.length).toBeGreaterThan(0);
  const overridden = overrides.map((f) => f.replace(/\.android\.spec\.ts$/, '.spec.ts'));
  // Invariant: an override sits beside the desktop spec it replaces.
  for (const f of overridden) expect(fs.existsSync(path.join(E2E, f)), `${f} beside its override`).toBe(true);
  const by = listedFiles();
  // Invariant: android lists exactly ANDROID_SPECS plus the overrides outside flows/ and harness (an entry that no longer
  // resolves, an overridden desktop spec, or any unlisted spec on android fails).
  const androidTop = [...(by.android ?? [])].filter((f) => !f.startsWith('flows/') && f !== 'harness.spec.ts').sort();
  expect(androidTop).toEqual([...ANDROID_SPECS, ...overrides].sort());
  // Invariant: android lists every flows/ spec on disk, so dropping the flows glob from its testMatch fails here.
  const flows = fs.readdirSync(E2E, { recursive: true, encoding: 'utf8' }).filter((f) => f.startsWith('flows/') && f.endsWith('.spec.ts')).sort();
  expect(flows.length).toBeGreaterThan(0);
  expect([...(by.android ?? [])].filter((f) => f.startsWith('flows/')).sort()).toEqual(flows);
  // Invariant: android lists the harness spec.
  expect(by.android?.has('harness.spec.ts')).toBe(true);
  for (const project of ['desktop', 'phone']) {
    const listed = (files: string[]) => files.filter((f) => by[project]?.has(f) ?? false);
    // Invariant: desktop and phone run every shared android spec and every overridden desktop spec.
    expect(listed([...ANDROID_SPECS, ...overridden].sort()), project).toEqual([...ANDROID_SPECS, ...overridden].sort());
    // Invariant: neither runs an override.
    expect(listed(overrides), project).toEqual([]);
  }
}, 60_000);
