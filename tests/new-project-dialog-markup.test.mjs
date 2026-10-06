// WHERE THE REMOTE FIELD SITS in the shipped New project dialog.
//
// tests/new-project-placement.test.mjs builds its own fragment, so it pins the
// module's behaviour and nothing about `public/index.html`. The order of the
// fields is markup alone: the target is chosen right after the System and
// before the path on it, because the path picker completes against the chosen
// target. Same harness as tests/adopt-dialog-markup.test.mjs — the real
// index.html into happy-dom, scripts stripped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function renderIndex() {
  const html = (await fs.readFile(path.join(PUB, 'index.html'), 'utf8'))
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const window = new Window({ url: 'http://localhost/' });
  window.document.documentElement.innerHTML = html;
  return window;
}

// PINS DROPDOWN ABOVE PATH: in the real markup the System label comes first,
// then the Remote row holding both the dropdown and the free-text field, then
// its note, then the path row.
test('the Remote row renders above the path field', async () => {
  const window = await renderIndex();
  const $ = id => window.document.getElementById(id);
  const systemLabel = $('np-system').closest('label');
  const remoteRow = $('np-remote-row');
  const note = $('np-remote-note');
  const pathRow = $('np-system-path-row');
  for (const [name, el] of Object.entries({ systemLabel, remoteRow, note, pathRow })) assert.ok(el, `${name} exists`);

  const follows = (a, b) => (a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  assert.ok(follows(systemLabel, remoteRow), 'the Remote row follows the System label');
  assert.ok(follows(remoteRow, note), 'the note follows the Remote row');
  assert.ok(follows(note, pathRow), 'and the path row follows the note');
  assert.ok(follows(remoteRow, pathRow), 'so the Remote row is above the path field');

  assert.equal($('np-remote-select').closest('label'), remoteRow, 'the dropdown is inside the Remote row');
  assert.equal($('np-remote').closest('label'), remoteRow, 'and so is the free-text field');
  assert.equal($('np-remote-select').tagName, 'SELECT');
  assert.equal($('np-remote-select').hidden, true, 'the dropdown starts hidden');
});
