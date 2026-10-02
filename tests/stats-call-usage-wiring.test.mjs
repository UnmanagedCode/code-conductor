// THE SHIPPED WIRING of the "Show mid-turn statistics" box.
//
// tests/conversation-call-usage.test.mjs builds installSessionStats itself and
// hands it header.js's two accessors, so it pins the behaviour and nothing about
// `public/app.js`. Dropping either accessor from app.js's install call would
// leave that file green while the real Statistics dialog threw on open (an
// undefined isCallUsageShown) or on tick (an undefined setCallUsageShown). The
// wiring is therefore asserted against app.js's source, as
// tests/adopt-dialog-markup.test.mjs does for the adopt dialog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// PINS: app.js passes BOTH header accessors into installSessionStats, taking
// each from the live headerHandle, and builds headerHandle first (the accessors
// are read off it by value when the call runs).
test('app.js wires headerHandle.isCallUsageShown and .setCallUsageShown into installSessionStats', async () => {
  const appJs = await fs.readFile(path.join(PUB, 'app.js'), 'utf8');

  const call = appJs.match(/installSessionStats\(\{[\s\S]*?\}\);/);
  assert.ok(call, 'app.js calls installSessionStats');
  for (const key of ['isCallUsageShown', 'setCallUsageShown']) {
    assert.match(call[0], new RegExp(`\\b${key}: headerHandle\\.${key}\\b`),
      `the install call passes ${key} from headerHandle`);
  }

  const built = appJs.indexOf('headerHandle = installHeader(');
  assert.ok(built >= 0, 'app.js assigns headerHandle from installHeader');
  assert.ok(built < appJs.indexOf(call[0]),
    'headerHandle is built before installSessionStats reads its accessors');
});
