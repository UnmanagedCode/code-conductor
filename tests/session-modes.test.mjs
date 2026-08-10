// The session-mode sidecar and, more importantly, the EFFECTIVE-mode rule
// layered on top of it.
//
// The rule: a resume comes up in the recorded mode, or DEFAULT_RESUME_MODE
// (bypassPermissions) when there is no record. There is deliberately no
// backfill, so every session that predates the store is unrecorded — and an
// unrecorded session still resumes HOT. Anything that reports on a resume must
// therefore report the effective mode, never the raw record. Reading "no
// record" as "not hot" would tell a reader a hot resume is safe, which is the
// defect these tests exist to catch.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  MODES, DEFAULT_MODE, DEFAULT_RESUME_MODE, effectiveResumeMode, resumesHot,
  loadAll, getSessionMode, markSessionMode, unmarkSessionMode,
} from '../src/sessionModes.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { renderSessions } from '../src/mcp/readRenderers.ts';

const SID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let home;
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await rmrf(home); });

const storeFile = () => path.join(orchStoreRoot(), 'session-modes.json');
const readStore = async () => JSON.parse(await fs.readFile(storeFile(), 'utf8'));

// ---------- the effective-mode rule ----------

test('an unrecorded session resolves to bypassPermissions — the pre-store behaviour', () => {
  assert.equal(effectiveResumeMode(null), 'bypassPermissions');
  assert.equal(effectiveResumeMode(undefined), 'bypassPermissions');
  assert.equal(effectiveResumeMode(''), 'bypassPermissions');
  assert.equal(effectiveResumeMode(null), DEFAULT_RESUME_MODE);
});

test('a recorded mode is returned verbatim, including the cold ones', () => {
  assert.equal(effectiveResumeMode('plan'), 'plan');
  assert.equal(effectiveResumeMode('ask'), 'ask');
  assert.equal(effectiveResumeMode('bypassPermissions'), 'bypassPermissions');
});

test('effectiveResumeMode never returns a value outside the mode vocabulary', () => {
  for (const recorded of [null, undefined, '', ...MODES]) {
    assert.ok(MODES.includes(effectiveResumeMode(recorded)),
      `effectiveResumeMode(${JSON.stringify(recorded)}) left the vocabulary`);
  }
});

test('only bypassPermissions is hot — ask is gated, plan is read-only', () => {
  assert.equal(resumesHot('bypassPermissions'), true);
  assert.equal(resumesHot('ask'), false, 'every destructive tool in ask is hook-gated');
  assert.equal(resumesHot('plan'), false);
  // The rule that matters, stated as one expression: no record ⇒ hot.
  assert.equal(resumesHot(effectiveResumeMode(null)), true);
});

test('a fresh spawn default is cold and distinct from the resume default', () => {
  assert.equal(DEFAULT_MODE, 'plan');
  assert.notEqual(DEFAULT_MODE, DEFAULT_RESUME_MODE);
});

// ---------- the renderer honours the rule ----------

const row = (over = {}) => ({
  sessionId: SID_A, firstPrompt: null, title: 't', conducted: false, temp: false,
  archived: false, lastActivity: 1, size: 1, playbook: null, stage: null,
  resumeMode: DEFAULT_RESUME_MODE, ...over,
});
const group = (rows) => [{
  project: 'p', worktree: null, path: '/p', branch: 'main', mergeStatus: null,
  live: [], inactive: rows, archivedCount: 0,
}];

test('an unrecorded session renders the resumes-hot flag', () => {
  // THE regression to prevent: no record + no flag reads as "safe to resume"
  // for a session that comes up with ungated tool use.
  const out = renderSessions(group([row({ resumeMode: effectiveResumeMode(null) })]));
  assert.match(out, /resumes-hot/,
    `an unrecorded session resumes hot and must say so:\n${out}`);
});

test('a recorded plan session renders no flag', () => {
  const out = renderSessions(group([row({ resumeMode: 'plan' })]));
  assert.ok(!out.includes('resumes-hot'), `plan does not resume hot:\n${out}`);
});

test('the flag tracks the mode, row by row, in one listing', () => {
  // Two rows in one render: a flag that is really a constant (always on, or
  // always off) fails here but could pass either single-row test above.
  const out = renderSessions(group([
    row({ sessionId: SID_A, title: 'cold', resumeMode: 'plan' }),
    row({ sessionId: SID_B, title: 'hot', resumeMode: 'bypassPermissions' }),
  ]));
  const line = (t) => out.split('\n').find(l => l.includes(t));
  assert.ok(!line('cold').includes('resumes-hot'), `cold row must not flag:\n${out}`);
  assert.match(line('hot'), /resumes-hot/, `hot row must flag:\n${out}`);
});

// ---------- the store ----------

test('mark then read round-trips, and unmark removes it', async () => {
  assert.equal(await getSessionMode(SID_A), null, 'absent before anything is written');
  await markSessionMode(SID_A, 'plan');
  assert.equal(await getSessionMode(SID_A), 'plan');
  assert.equal((await loadAll()).get(SID_A), 'plan');

  await markSessionMode(SID_A, 'bypassPermissions');
  assert.equal(await getSessionMode(SID_A), 'bypassPermissions', 'a later mark wins');

  assert.equal(await unmarkSessionMode(SID_A), true);
  assert.equal(await getSessionMode(SID_A), null);
  // An unrecorded session is hot again — removal must not read as "cold".
  assert.equal(resumesHot(effectiveResumeMode(await getSessionMode(SID_A))), true);
});

test('the store keys by session, so one session cannot overwrite another', async () => {
  await markSessionMode(SID_A, 'plan');
  await markSessionMode(SID_B, 'bypassPermissions');
  assert.equal(await getSessionMode(SID_A), 'plan');
  assert.equal(await getSessionMode(SID_B), 'bypassPermissions');
});

test('a re-mark of the same value does not rewrite the file', async () => {
  await markSessionMode(SID_A, 'plan');
  const before = (await fs.stat(storeFile())).mtimeMs;
  await markSessionMode(SID_A, 'plan');
  assert.equal((await fs.stat(storeFile())).mtimeMs, before, 'idempotent mark must be a no-op');
});

test('the file is removed once the last entry goes', async () => {
  await markSessionMode(SID_A, 'plan');
  await unmarkSessionMode(SID_A);
  await assert.rejects(fs.stat(storeFile()), { code: 'ENOENT' });
});

test('a mode outside the vocabulary is refused, not stored', async () => {
  assert.equal(await markSessionMode(SID_A, 'acceptEdits'), false);
  assert.equal(await markSessionMode(SID_A, ''), false);
  assert.equal(await markSessionMode(SID_A, undefined), false);
  assert.equal(await getSessionMode(SID_A), null);
});

test('an empty or missing sessionId is refused', async () => {
  assert.equal(await markSessionMode('', 'plan'), false);
  assert.equal(await markSessionMode(undefined, 'plan'), false);
  assert.equal(await getSessionMode(''), null);
  assert.equal(await unmarkSessionMode(''), false);
});

test('a corrupt store degrades to empty rather than throwing — so a resume still works', async () => {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(storeFile(), '{ this is not json');
  assert.deepEqual([...(await loadAll())], []);
  // And the session resolves to the hot default, not to a crash or a fake cold.
  assert.equal(effectiveResumeMode(await getSessionMode(SID_A)), 'bypassPermissions');
});

test('an on-disk entry with an unknown mode is dropped, not trusted', async () => {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(storeFile(), JSON.stringify({
    sessions: { [SID_A]: 'acceptEdits', [SID_B]: 'plan' },
  }));
  const map = await loadAll();
  assert.equal(map.has(SID_A), false, 'an invalid mode must not reach a spawn');
  assert.equal(map.get(SID_B), 'plan', 'valid siblings survive');
  // Dropped ⇒ unrecorded ⇒ hot. Degrading to a *colder* mode would be the
  // wrong direction: it would silently change what a resume can do.
  assert.equal(effectiveResumeMode(map.get(SID_A) ?? null), 'bypassPermissions');
});

test('the persisted shape is the documented {sessions:{sid:mode}} map', async () => {
  await markSessionMode(SID_A, 'ask');
  assert.deepEqual(await readStore(), { sessions: { [SID_A]: 'ask' } });
});
