// The prune dialog's savings readout (public/pruneDialog.js), rendered against a
// real happy-dom document and a stubbed analysis endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const REAL_FETCH = globalThis.fetch;

// The pd-* ids public/index.html's #prune-dialog carries.
const DIALOG_HTML = `
  <dialog id="prune-dialog">
    <form method="dialog">
      <span id="pd-cut-label"></span>
      <input type="range" id="pd-cut" min="0" max="0" step="1" value="0" />
      <input type="checkbox" id="pd-thinking" checked />
      <input type="checkbox" id="pd-minimal" />
      <div id="pd-savings"></div>
      <p id="pd-error" hidden></p>
      <button id="pd-apply" type="button">Prune</button>
    </form>
  </dialog>`;

const zeroTurn = (index) => ({ index, preview: '', thinking: 0, toolInputTruncatable: 0, toolInputMinimal: 0, toolOutput: 0, total: 0 });

test('the prune dialog renders millions with the M unit', async (t) => {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = DIALOG_HTML;
  const analysis = {
    turnCount: 2,
    totalTokens: 3_000_000,
    turns: [{ ...zeroTurn(0), toolOutput: 1_927_800, total: 1_927_800 }, zeroTurn(1)],
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => analysis });
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
    window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  const { installPruneDialog } = await import(pathToFileURL(path.join(PUB, 'pruneDialog.js')).href);
  const { open } = installPruneDialog({
    dom: { pruneDialog: window.document.getElementById('prune-dialog') },
    getActiveId: () => 'inst-1',
    refreshInstances: async () => {},
  });
  await open();

  const cells = [...window.document.querySelectorAll('#pd-savings td')].map(td => td.textContent);
  const row = (label) => cells[cells.indexOf(label) + 1];
  assert.equal(row('Tool outputs'), '~1.9M tokens');
  assert.equal(row('Estimated total saved'), '~1.9M tokens');
});
