// Ownership of the projects-root `CLAUDE.md` — the file every project imports
// via `@../CLAUDE.md`. code-conductor now bundles the canonical text
// (assets/cc-projects-CLAUDE.md), mirrors it into `<PROJECTS_ROOT>/CLAUDE.md`
// on startup, and resolves the "both changed" conflict through the Settings UI.
// This replaces termux-code-conductor's `scripts/lib.sh::sync_workspace_claudemd`.
//
// The reconcile is a sha256 three-way compare between:
//   vendor   = our bundled canonical (source of truth going forward)
//   target   = <PROJECTS_ROOT>/CLAUDE.md
//   baseline = the last-applied canonical, persisted by us in the central store
//
//   target missing                          → create   (copy vendor→target)
//   target == vendor                         → up-to-date (bump baseline)
//   target == baseline (untouched), vendor ≠ → silent-update (copy vendor→target)
//   target ≠ baseline, baseline == vendor    → keep   (user edited, vendor same)
//   target ≠ baseline, baseline ≠ vendor     → conflict (record, resolve in UI)
//
// Conflict resolutions (mirror update.sh exactly):
//   keep      → baseline := vendor, file unchanged (won't re-prompt until vendor moves)
//   overwrite → back up target to <target>.bak-<YYYYMMDD-HHMMSS>, copy vendor→target, bump baseline
//   diff      → unified diff (target vs canonical)

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectsRoot, orchStoreRoot, writeFileAtomic } from './projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths ────────────────────────────────────────────────────────────────

// The bundled canonical. `CC_VENDOR_CLAUDEMD` overrides it purely for tests
// that need a "vendor changed" scenario against a different fixture.
export function vendorPath() {
  return process.env.CC_VENDOR_CLAUDEMD
    ?? path.join(__dirname, '..', 'assets', 'cc-projects-CLAUDE.md');
}

export function targetPath() {
  return path.join(projectsRoot(), 'CLAUDE.md');
}

function storeDir() {
  return path.join(orchStoreRoot(), 'workspace-claudemd');
}

export function baselinePath() {
  return path.join(storeDir(), 'baseline.md');
}

function statePath() {
  return path.join(storeDir(), 'state.json');
}

// ── Vendor text (cached by resolved path, like appSettings) ────────────────

let vendorCache = null;
let vendorCachedFor = null;

export function vendorText() {
  const p = vendorPath();
  if (vendorCache !== null && vendorCachedFor === p) return vendorCache;
  // Synchronous read at module use — the file is tiny and read paths are cold.
  vendorCache = readFileSync(p, 'utf8');
  vendorCachedFor = p;
  return vendorCache;
}

// ── sha + small fs helpers ─────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readFileOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function fileExists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function readBaseline() {
  return readFileOrNull(baselinePath());
}

async function writeBaseline(text) {
  await writeFileAtomic(baselinePath(), text);
}

async function readState() {
  const raw = await readFileOrNull(statePath());
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeState(state) {
  await writeFileAtomic(statePath(), JSON.stringify(state, null, 2));
}

// ── Classification (pure) ──────────────────────────────────────────────────

// Returns one of: create | up-to-date | silent-update | keep | conflict
export function classify({ targetExists, targetSha, baselineSha, vendorSha }) {
  if (!targetExists) return 'create';
  if (targetSha === vendorSha) return 'up-to-date';
  // target differs from vendor below.
  if (targetSha === baselineSha) return 'silent-update'; // user untouched, vendor moved
  // user edited the target.
  if (baselineSha === vendorSha) return 'keep'; // vendor unchanged → respect the edit
  return 'conflict'; // both changed
}

// Map an internal classification to the public status enum.
function statusFromClass(cls) {
  switch (cls) {
    case 'create': return 'created';
    case 'silent-update': return 'updated';
    case 'keep': return 'kept';
    case 'conflict': return 'conflict';
    default: return 'up-to-date';
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────

// Seed our baseline from vendor if absent. Idempotent. (A prior legacy TCC
// baseline, if any, was already migrated in by a boot-time migration —
// see migrations/0009-seed-legacy-shell-installer-baseline.mjs.)
export async function seedBaselineIfNeeded() {
  if (await fileExists(baselinePath())) return { seeded: false };
  await writeBaseline(vendorText());
  return { seeded: true, from: 'vendor' };
}

// ── Reconcile (mutating; runs on startup) ──────────────────────────────────

export async function reconcile({ log } = {}) {
  await seedBaselineIfNeeded();
  const vendor = vendorText();
  const vendorSha = sha256(vendor);
  const tPath = targetPath();
  const target = await readFileOrNull(tPath);
  const targetExists = target != null;
  const baseline = await readBaseline(); // present after seed
  const cls = classify({
    targetExists,
    targetSha: targetExists ? sha256(target) : null,
    baselineSha: baseline != null ? sha256(baseline) : null,
    vendorSha,
  });

  switch (cls) {
    case 'create':
      await fs.mkdir(path.dirname(tPath), { recursive: true });
      await fs.writeFile(tPath, vendor);
      await writeBaseline(vendor);
      break;
    case 'up-to-date':
      await writeBaseline(vendor); // bump (no-op if already equal)
      break;
    case 'silent-update':
      await fs.writeFile(tPath, vendor);
      await writeBaseline(vendor);
      break;
    case 'keep':
    case 'conflict':
      break; // file untouched
  }

  const outcome = statusFromClass(cls);
  await writeState({ outcome, at: new Date().toISOString() });
  if (log && typeof log.log === 'function') {
    log.log(`root CLAUDE.md reconcile: ${outcome} (target ${tPath})`);
  }
  return { status: outcome, conflict: cls === 'conflict', targetExists: true };
}

// ── Status (read-only) ─────────────────────────────────────────────────────

export async function getStatus() {
  const vendor = vendorText();
  const vendorSha = sha256(vendor);
  const tPath = targetPath();
  const target = await readFileOrNull(tPath);
  const targetExists = target != null;
  // If never seeded (e.g. status queried before any reconcile), emulate the
  // seed in-memory without writing: vendor.
  const baseline = (await readBaseline()) ?? vendor;
  const cls = classify({
    targetExists,
    targetSha: targetExists ? sha256(target) : null,
    baselineSha: sha256(baseline),
    vendorSha,
  });

  let status = statusFromClass(cls);
  // Recover the created/updated nuance (which a live "up-to-date" classify
  // can't tell apart) from the persisted reconcile outcome.
  if (cls === 'up-to-date') {
    const st = await readState();
    if (st && ['created', 'updated', 'up-to-date'].includes(st.outcome)) {
      status = st.outcome;
    }
  }

  return {
    status,
    conflict: cls === 'conflict',
    targetExists,
    targetPath: tPath,
    vendorPath: vendorPath(),
    baselinePath: baselinePath(),
  };
}

// ── Diff (target vs canonical) ─────────────────────────────────────────────

export async function getDiff() {
  const vendor = vendorText();
  const target = (await readFileOrNull(targetPath())) ?? '';
  return { diff: unifiedDiff(target, vendor, 'a/CLAUDE.md (your copy)', 'b/CLAUDE.md (canonical)') };
}

// ── Resolution ──────────────────────────────────────────────────────────────

function timestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function resolve(action) {
  const vendor = vendorText();
  const tPath = targetPath();
  if (action === 'keep') {
    // baseline becomes the next baseline; file unchanged.
    await writeBaseline(vendor);
    await writeState({ outcome: 'kept', at: new Date().toISOString() });
    return getStatus();
  }
  if (action === 'overwrite') {
    const current = await readFileOrNull(tPath);
    if (current != null) {
      const bak = `${tPath}.bak-${timestamp(new Date())}`;
      await fs.writeFile(bak, current);
    }
    await fs.mkdir(path.dirname(tPath), { recursive: true });
    await fs.writeFile(tPath, vendor);
    await writeBaseline(vendor);
    await writeState({ outcome: 'updated', at: new Date().toISOString() });
    return getStatus();
  }
  throw Object.assign(new Error('unknown action — use keep or overwrite'), { statusCode: 400 });
}

// ── Unified diff helper (LCS-based, 3-line context) ────────────────────────

function lcsLengths(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

// Produce an edit script of {t:' '|'-'|'+', line, aLine, bLine, srcIdx}.
function diffOps(a, b) {
  const dp = lcsLengths(a, b);
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i], aLine: i + 1, bLine: j + 1, srcIdx: i });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', line: a[i], aLine: i + 1, bLine: null, srcIdx: i });
      i++;
    } else {
      ops.push({ t: '+', line: b[j], aLine: null, bLine: j + 1, srcIdx: i });
      j++;
    }
  }
  while (i < a.length) { ops.push({ t: '-', line: a[i], aLine: i + 1, bLine: null, srcIdx: i }); i++; }
  while (j < b.length) { ops.push({ t: '+', line: b[j], aLine: null, bLine: j + 1, srcIdx: i }); j++; }
  return ops;
}

export function unifiedDiff(aText, bText, aLabel = 'a', bLabel = 'b', context = 3) {
  if (aText === bText) return '';
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  const ops = diffOps(a, b);
  const changed = ops.map(o => o.t !== ' ');
  const n = ops.length;

  const lines = [`--- ${aLabel}`, `+++ ${bLabel}`];
  let idx = 0;
  while (idx < n) {
    if (!changed[idx]) { idx++; continue; }
    const start = Math.max(0, idx - context);
    // Extend the hunk until `context` unchanged lines follow the last change.
    let lastChange = idx, k = idx;
    while (k < n) {
      if (changed[k]) lastChange = k;
      else if (k - lastChange >= context) break;
      k++;
    }
    const end = Math.min(n - 1, lastChange + context);

    const slice = ops.slice(start, end + 1);
    let aCount = 0, bCount = 0, aStart = 0, bStart = 0;
    for (const op of slice) {
      if (op.t === ' ' || op.t === '-') { if (!aCount) aStart = op.aLine; aCount++; }
      if (op.t === ' ' || op.t === '+') { if (!bCount) bStart = op.bLine; bCount++; }
    }
    if (!aCount) aStart = slice[0].srcIdx; // pure insertion → line before insert
    if (!bCount) bStart = 0;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) lines.push(`${op.t}${op.line}`);
    idx = end + 1;
  }
  return lines.join('\n') + '\n';
}
