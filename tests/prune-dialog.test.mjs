// The Prune dialog's savings readout (public/pruneDialog.js): every figure is the
// analysis's raw per-turn sum scaled by its calibration factor, and the
// percentage is taken against the ctx chip's reading — never against an
// estimated denominator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const turn = (index, o = {}) => ({
  index, preview: `turn ${index}`, thinking: 0, toolInputTruncatable: 0, toolInputMinimal: 0,
  toolOutput: 0, exempt: 0, total: 0, ...o,
});

// Three turns, so the dialog's default cut is 2: turns 0 and 1 are the prefix.
function analysis(o = {}) {
  return {
    turnCount: 3,
    turns: [turn(0, { toolOutput: 1000 }), turn(1, { toolInputTruncatable: 200 }), turn(2, { toolOutput: 50000 })],
    encryptedThinking: 0,
    calibration: { factor: 1.5, steps: 12, calibrated: true },
    contextTokens: 92200,
    ...o,
  };
}

let counter = 0;
async function openDialog(payload) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  const impl = async () => ({ ok: true, status: 200, json: async () => payload });
  window.fetch = impl;
  globalThis.fetch = impl;
  document.body.innerHTML = `
    <dialog id="prune-dialog">
      <span id="pd-cut-label"></span>
      <input type="range" id="pd-cut" min="0" max="0" step="1" value="0" />
      <input type="checkbox" id="pd-thinking" checked />
      <input type="checkbox" id="pd-minimal" />
      <div id="pd-savings"></div>
      <p id="pd-error" hidden></p>
      <button id="pd-apply" type="button">Prune</button>
    </dialog>`;
  const dlg = document.getElementById('prune-dialog');
  dlg.showModal = function () { this.open = true; };
  dlg.close = function () { this.open = false; };
  const { installPruneDialog } = await import(
    pathToFileURL(path.join(PUB, 'pruneDialog.js')).href + `?t=${++counter}`);
  const { open } = installPruneDialog({ dom: { pruneDialog: dlg }, getActiveId: () => 'i1', refreshInstances: async () => {} });
  await open();
  const savings = document.getElementById('pd-savings');
  const rows = () => Object.fromEntries([...savings.querySelectorAll('tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent)));
  const setCut = (v) => {
    const cut = document.getElementById('pd-cut');
    cut.value = String(v);
    cut.dispatchEvent(new window.Event('input'));
  };
  return { savings, rows, setCut };
}

test('the percentage is of the ctx chip\'s reading, not of an estimate', async () => {
  const { savings } = await openDialog(analysis());
  // (1000 + 200) × 1.5 = 1800 of 92,200.
  assert.match(savings.textContent, /~2% of current context \(92k tokens — the ctx chip's reading\)/);
  assert.doesNotMatch(savings.textContent, /conversation tokens/);
  assert.match(savings.textContent, /Calibrated against this session's real token usage\./);
});

test('with no ctx reading the dialog shows no percentage', async () => {
  const { savings } = await openDialog(analysis({ contextTokens: null }));
  assert.match(savings.textContent, /No current context reading yet — it returns after the session's next turn\./);
  assert.doesNotMatch(savings.textContent, /%/);
});

test('a fallback factor is labelled uncalibrated even with measured steps', async () => {
  // Thin history: steps were measured, but too little to trust, so factor is 1.
  const { savings } = await openDialog(analysis({ calibration: { factor: 1, steps: 2, calibrated: false } }));
  assert.match(savings.textContent, /Uncalibrated estimate — not enough usage history yet\./);
  assert.doesNotMatch(savings.textContent, /Calibrated against/);
});

test('every figure is the raw sum times the calibration factor', async () => {
  const { rows } = await openDialog(analysis());
  const r = rows();
  assert.equal(r['Tool outputs'], '~1.5k tokens');
  assert.equal(r['Tool inputs'], '~300 tokens');
  assert.equal(r['Estimated total saved'], '~1.8k tokens');
});

test('encrypted thinking reads as not removable, sized and kept', async () => {
  const { rows } = await openDialog(analysis({ encryptedThinking: 8000 }));
  assert.equal(rows().Thinking, 'n/a — stored encrypted (~12k in context, kept)');
});

test('the exempt row appears only when the selected prefix holds exempt payload', async () => {
  const { rows, setCut } = await openDialog(analysis({
    turns: [turn(0, { toolOutput: 1000 }), turn(1), turn(2, { exempt: 5000 })],
  }));
  const label = 'Kept — orchestration calls (exempt)';
  assert.ok(!(label in rows()), 'no exempt payload in turns [0, 2)');
  setCut(3);
  assert.equal(rows()[label], '~7.5k tokens');
});

test('the prune dialog renders millions with the M unit', async () => {
  const { rows } = await openDialog(analysis({
    turnCount: 2,
    turns: [turn(0, { toolOutput: 1_927_800, total: 1_927_800 }), turn(1)],
    calibration: { factor: 1, steps: 0, calibrated: false },
  }));
  const r = rows();
  assert.equal(r['Tool outputs'], '~1.9M tokens');
  assert.equal(r['Estimated total saved'], '~1.9M tokens');
});
