// Tests for the lazy per-file diff loading in public/review.js: the initial
// payload renders a per-file summary with zero fetches, and hunks for one
// file are fetched only when its <details> card is expanded (cached after).
//
// Mirrors the harness in tests/account-overage.test.mjs (build the DOM by
// hand, cache-busted dynamic import so module-level state doesn't leak across
// tests, await window.happyDOM.waitUntilComplete() for async settling).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildDOM(document) {
  const main = document.createElement('div');
  main.id = 'main';

  const view = document.createElement('section');
  view.id = 'review-view';
  view.hidden = true;

  const header = document.createElement('div');
  header.id = 'review-header';
  const back = document.createElement('button');
  back.id = 'review-back';
  header.appendChild(back);
  const info = document.createElement('div');
  info.id = 'review-info';
  const title = document.createElement('span');
  title.id = 'review-title';
  const stats = document.createElement('span');
  stats.id = 'review-stats';
  info.append(title, stats);
  header.appendChild(info);
  view.appendChild(header);

  const msg = document.createElement('pre');
  msg.id = 'review-commit-message';
  msg.hidden = true;
  view.appendChild(msg);

  const fileList = document.createElement('div');
  fileList.id = 'review-file-list';
  view.appendChild(fileList);

  main.appendChild(view);
  document.body.appendChild(main);
  return { main, view, fileList };
}

function summaryPayload(files) {
  return {
    project: 'demo', worktreeName: 'demo_worktree_ab12', baseRef: 'main',
    files,
    totalAdds: files.reduce((s, f) => s + f.adds, 0),
    totalDels: files.reduce((s, f) => s + f.dels, 0),
    totalFiles: files.length,
  };
}

function fileDetailPayload(path, overrides = {}) {
  return {
    project: 'demo', path,
    file: {
      path, oldPath: null, status: 'modified', adds: 1, dels: 0, binary: false,
      hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [{ type: 'ctx', content: 'a' }, { type: 'add', content: 'b' }] }],
      truncated: false, oversized: false, bytes: 42,
      ...overrides,
    },
  };
}

let counter = 0;
async function setup(fetchImpl) {
  const window = new Window({ url: 'http://localhost/#' });
  window.fetch = fetchImpl;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.fetch = window.fetch;

  const dom = buildDOM(window.document);

  const url = pathToFileURL(
    path.resolve(__dirname, '..', 'public', 'review.js'),
  ).href + '?t=' + (++counter);
  const mod = await import(url);
  return { window, mod, ...dom };
}

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

test('review: summary renders all files with zero per-file fetches', async () => {
  const calls = [];
  const impl = (u) => {
    calls.push(u);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryPayload([
      { path: 'a.js', oldPath: null, status: 'modified', adds: 3, dels: 1, binary: false },
      { path: 'b.js', oldPath: null, status: 'added', adds: 5, dels: 0, binary: false },
    ])) });
  };
  const { window, mod, fileList } = await setup(impl);
  mod.installReview().open({ title: 'demo', url: '/api/projects/demo/worktrees/demo_worktree_ab12/diff' });
  await window.happyDOM.waitUntilComplete();
  await tick();

  const cards = fileList.querySelectorAll('.review-file');
  assert.equal(cards.length, 2, 'both files rendered');
  assert.equal(calls.length, 1, 'only the summary fetch was issued');
  window.happyDOM.abort();
});

test('review: expanding a card issues exactly one fetch for that file and renders its hunks', async () => {
  const calls = [];
  const impl = (u) => {
    calls.push(u);
    if (u.includes('path=')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fileDetailPayload('a.js')) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryPayload([
      { path: 'a.js', oldPath: null, status: 'modified', adds: 1, dels: 0, binary: false },
    ])) });
  };
  const { window, mod, fileList } = await setup(impl);
  mod.installReview().open({ title: 'demo', url: '/api/projects/demo/worktrees/demo_worktree_ab12/diff' });
  await window.happyDOM.waitUntilComplete();
  await tick();

  const details = fileList.querySelector('details.review-file');
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  await tick();

  assert.equal(calls.length, 2, 'summary + exactly one per-file fetch');
  assert.ok(calls[1].includes('path=a.js'));
  const lines = details.querySelectorAll('.diff-line');
  assert.ok(lines.length > 0, 'hunk lines rendered');

  // Collapse and re-expand: no further fetch (cached).
  details.open = false;
  details.dispatchEvent(new window.Event('toggle'));
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  await tick();
  assert.equal(calls.length, 2, 'no refetch on re-expand');
  window.happyDOM.abort();
});

test('review: a failed per-file fetch renders an error with a working retry', async () => {
  let attempt = 0;
  const calls = [];
  const impl = (u) => {
    calls.push(u);
    if (u.includes('path=')) {
      attempt++;
      if (attempt === 1) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fileDetailPayload('a.js')) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryPayload([
      { path: 'a.js', oldPath: null, status: 'modified', adds: 1, dels: 0, binary: false },
    ])) });
  };
  const { window, mod, fileList } = await setup(impl);
  mod.installReview().open({ title: 'demo', url: '/api/projects/demo/worktrees/demo_worktree_ab12/diff' });
  await window.happyDOM.waitUntilComplete();
  await tick();

  const details = fileList.querySelector('details.review-file');
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  await tick();

  let errEl = details.querySelector('.review-file-error');
  assert.ok(errEl, 'error state rendered');
  assert.match(errEl.textContent, /boom/);

  const retry = details.querySelector('.review-file-retry');
  assert.ok(retry, 'retry button present');
  retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();

  assert.equal(calls.length, 3, 'summary + failed attempt + retry');
  assert.equal(details.querySelector('.review-file-error'), null, 'error cleared after successful retry');
  assert.ok(details.querySelectorAll('.diff-line').length > 0, 'hunks rendered after retry');
  window.happyDOM.abort();
});

test('review: an oversized file renders a note with no diff lines', async () => {
  const impl = (u) => {
    if (u.includes('path=')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(fileDetailPayload('huge.txt', { oversized: true, hunks: [], adds: 30000, dels: 0 })),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryPayload([
      { path: 'huge.txt', oldPath: null, status: 'modified', adds: 30000, dels: 0, binary: false },
    ])) });
  };
  const { window, mod, fileList } = await setup(impl);
  mod.installReview().open({ title: 'demo', url: '/api/projects/demo/worktrees/demo_worktree_ab12/diff' });
  await window.happyDOM.waitUntilComplete();
  await tick();

  const details = fileList.querySelector('details.review-file');
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  await tick();

  assert.ok(details.querySelector('.review-file-note'), 'oversized note rendered');
  assert.equal(details.querySelectorAll('.diff-line').length, 0, 'no diff lines for an oversized file');
  window.happyDOM.abort();
});

test('review: a binary file renders its note with no fetch at all', async () => {
  const calls = [];
  const impl = (u) => {
    calls.push(u);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryPayload([
      { path: 'image.png', oldPath: null, status: 'modified', adds: 0, dels: 0, binary: true },
    ])) });
  };
  const { window, mod, fileList } = await setup(impl);
  mod.installReview().open({ title: 'demo', url: '/api/projects/demo/worktrees/demo_worktree_ab12/diff' });
  await window.happyDOM.waitUntilComplete();
  await tick();

  const details = fileList.querySelector('details.review-file');
  assert.ok(details.querySelector('.review-file-note'), 'binary note rendered up front');
  assert.equal(calls.length, 1, 'only the summary fetch — no per-file fetch for a binary card');

  // Expanding it still must not fetch.
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  await tick();
  assert.equal(calls.length, 1, 'expanding a binary card issues no fetch');
  window.happyDOM.abort();
});
