// projectsOperation (src/projectsChanged.ts) turns an operation's writes into
// one `projects` signal when the outermost operation ends, whether it returns
// or throws, and none when it wrote nothing; a created project signals only
// once it is whole.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { markProjectsChanged, onProjectsChanged, projectsOperation } from '../src/projectsChanged.ts';
import { createProject } from '../src/projects.ts';

let signals = 0;
/** Runs inside the listener, so it sees the state at the moment of the signal. */
let atSignal = null;
onProjectsChanged(() => { signals++; atSignal?.(); });

const { home, projectsRoot } = await freshProjectsRoot();
after(async () => { await rmrf(home); });

test('a write outside any operation signals at once', () => {
  const before = signals;
  markProjectsChanged();
  assert.equal(signals - before, 1);
});

test('nested operations signal once, when the outermost ends', async () => {
  const before = signals;
  await projectsOperation(async () => {
    markProjectsChanged();
    await projectsOperation(async () => { markProjectsChanged(); });
    assert.equal(signals - before, 0, 'nothing before the outermost operation ends');
  });
  assert.equal(signals - before, 1);
});

test('an operation that throws after a write signals once; one that throws or returns before any write signals none', async () => {
  let before = signals;
  await assert.rejects(projectsOperation(async () => { markProjectsChanged(); throw new Error('after the write'); }), /after the write/);
  assert.equal(signals - before, 1, 'a write that landed before the throw');
  before = signals;
  await assert.rejects(projectsOperation(async () => { throw new Error('refused'); }), /refused/);
  assert.equal(await projectsOperation(async () => 'no-op'), 'no-op');
  assert.equal(signals - before, 0, 'a refusal and a no-op');
});

test('a created project signals once, after its repository and CLAUDE.md exist', async () => {
  const seen = [];
  const dir = path.join(projectsRoot, 'whole');
  atSignal = () => { seen.push([existsSync(path.join(dir, '.git')), existsSync(path.join(dir, 'CLAUDE.md'))]); };
  try {
    const created = await createProject('whole');
    assert.equal(created.path, dir);
  } finally {
    atSignal = null;
  }
  assert.deepEqual(seen, [[true, true]]);
});
