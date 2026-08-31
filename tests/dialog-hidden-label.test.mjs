// A `<label hidden>` inside a <dialog> must actually be laid out as hidden.
//
// public/styles.css carries `dialog label { display: block; ... }`. An AUTHOR
// `display` outranks the UA stylesheet's `[hidden] { display: none }`, so every
// such label renders regardless of its `hidden` attribute — the same trap the
// sheet already documents for `.turn-indicator`. d3007496 added the New Project
// dialog's `<label id="np-system-path-row" hidden>` under the System dropdown
// and hit it: "Path on that system" stood there permanently, offsetting every
// row below the dropdown, and the JS toggling `.hidden` (newProjectDialog.js
// syncSystemPathRow) changed nothing on screen.
//
// tests/new-project-placement.test.mjs pins the `.hidden` PROPERTY for local vs
// remote; it builds a bare DOM with no stylesheet, so it cannot see whether
// `hidden` hides. This file is the other half: the real public/index.html under
// the real public/styles.css.
//
// happy-dom implements no UA stylesheet — a plain `<div hidden>` computes
// `block` here — so `display: none` below is only reachable via an author rule
// that matches `[hidden]`. That is precisely the invariant, and it makes these
// assertions strict rather than incidentally satisfied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// Scripts are stripped rather than merely blocked: index.html's module scripts
// are irrelevant to the cascade and only give happy-dom fetches to fail.
async function renderIndex() {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(PUB, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUB, 'styles.css'), 'utf8'),
  ]);
  const window = new Window({
    url: 'http://localhost/',
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  const document = window.document;
  document.write(html.replace(/<script\b[\s\S]*?<\/script>/g, ''));
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return { window, document };
}

const displayOf = (window, el) => window.getComputedStyle(el).display;

test('the New Project dialog\'s "Path on that system" row is laid out per its hidden attribute', async () => {
  const { window, document } = await renderIndex();
  const row = document.getElementById('np-system-path-row');
  assert.ok(row, 'index.html must still carry #np-system-path-row');
  assert.equal(row.hasAttribute('hidden'), true, 'it ships hidden — a local project has no path to choose');

  assert.equal(
    displayOf(window, row), 'none',
    'the row must not render while hidden; `dialog label { display: block }` outranks the UA [hidden] rule',
  );

  // The other direction: the reset must be scoped to [hidden], not blanket the
  // row out of existence for the remote case the dialog exists to offer.
  row.hidden = false;
  assert.notEqual(
    displayOf(window, row), 'none',
    'choosing a remote system must reveal the row',
  );
});

test('every hidden <label> in a dialog resolves to display:none under public/styles.css', async () => {
  const { window, document } = await renderIndex();
  const labels = [...document.querySelectorAll('dialog label[hidden]')];
  assert.ok(labels.length > 0, 'sanity: index.html has at least one hidden dialog label to check');
  for (const label of labels) {
    assert.equal(
      displayOf(window, label), 'none',
      `<label hidden> #${label.id || '(no id)'} renders anyway — add a [hidden] reset beside the rule that sets its display`,
    );
  }
});
