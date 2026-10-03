// installNewProjectDialog's `dom` map is assembled TWICE: public/app.js builds
// the page-wide `dom` object, then hands the dialog a second, hand-written
// literal of just its own handles. A handle added to the first and read by the
// module but missing from the second is `undefined` in the real page and throws
// at first use — while every happy-dom test of the module still passes, because
// each builds the whole map itself. app.js cannot be loaded under happy-dom
// (docs/frontend-testing.md), so this reads the two sources and compares the
// key sets. A source-shape check, not a behavioural one, because there is no
// harness that runs app.js's call sites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFile(path.join(PUB, f), 'utf8');

// Every `dom.<key>` / `dom?.<key>` the module reads.
const keysRead = (moduleSrc) => new Set([...moduleSrc.matchAll(/\bdom\??\.(\w+)/g)].map(m => m[1]));

// The keys of the `dom: { … }` literal handed to installNewProjectDialog.
function keysSupplied(appSrc) {
  const m = appSrc.match(/installNewProjectDialog\(\{\s*dom:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(m, 'the installNewProjectDialog({ dom: { … } }) call in app.js was reshaped; update this test\'s slice');
  return new Set([...m[1].matchAll(/^\s*(\w+):/gm)].map(k => k[1]));
}

const missing = (read, supplied) => [...read].filter(k => !supplied.has(k));

// PINS: every handle newProjectDialog.js reads is supplied at app.js's call
// site, so no create in the real page dereferences an undefined handle.
test('app.js hands installNewProjectDialog every dom handle the module reads', async () => {
  const [moduleSrc, appSrc] = await Promise.all([read('newProjectDialog.js'), read('app.js')]);
  assert.deepEqual(missing(keysRead(moduleSrc), keysSupplied(appSrc)), []);
});

// PINS: the extraction itself — it finds the module's handles and reports a
// key the supplied literal lacks (a control on the check, fed a literal built
// here rather than a perturbed app.js).
test('the wiring check reads the module\'s handles and names a missing one', () => {
  const read = keysRead('dom.a.hidden = true; dom?.b?.value; const x = dom.c;');
  assert.deepEqual([...read].sort(), ['a', 'b', 'c']);
  const supplied = keysSupplied('installNewProjectDialog({\n  dom: {\n    a: dom.a,\n    c: dom.c,\n  },\n  refresh,\n});');
  assert.deepEqual(missing(read, supplied), ['b']);
});
