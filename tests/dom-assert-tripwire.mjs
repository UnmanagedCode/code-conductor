// ============================================================================
// OWNERSHIP — do not delete this guard as "redundant with the scanner".
//
// `tests/dom-assert-tripwire.mjs` GUARDS THE PATH: *no DOM node ever reaches
// assert's serializer at runtime.* It bounds the damage from the shapes
// `tests/dom-assert-scan.mjs` is structurally blind to (a subject whose
// DOM-ness lives in a `public/` return value — `conv.emptyNode`,
// `main.leadingAssistantWrap`, `batch.leadingWrap` — and any new shape the
// scanner does not recognise), converting a 33-120 s stall into a named
// AssertionError.
//
// `tests/dom-assert-scan.mjs` OWNS the invariant (*no equal-family assertion in
// `tests/` is written against a DOM-valued expression*) and cannot be replaced
// by this file: a latent site that currently PASSES is invisible at runtime,
// which is exactly how the 51 sites swept by card 2026-0150 accumulated under a
// green suite. This tripwire only fires on a site that already fails.
// Overlap on most sites is intentional. Neither is redundant.
// ============================================================================
//
// Preloaded into every per-file test child via `--import` (see the `execArgv`
// option on `run({…})` in `tests/run.mjs`). If this module throws, the child
// exits 1 before the test body runs and `run.mjs`'s `test:fail` counter
// increments — it cannot silently no-op, which is the point: a silently-dead
// tripwire is the false safety this card exists to prevent.

import { createRequire } from 'node:module';
import { isDomNode, describeFound } from './domNode.mjs';

// createRequire, NEVER `import assert from 'node:assert'`. Measured: a static
// ESM import here instantiates node:assert's ESM namespace during the preload,
// snapshotting its named exports BEFORE the patch lands — after which
// `import { strictEqual } from 'node:assert'` in a test file silently bypasses
// the tripwire. Requiring the CJS module leaves the namespace uninstantiated,
// so all four styles (node:assert named + default, node:assert/strict named +
// default) see the patched functions. `tests/dom-assert-guard.test.mjs` T10
// pins this against a future "simplification".
const assertObj = createRequire(import.meta.url)('node:assert');

// Only the positive family. `notEqual(node, null)` and friends can only FAIL
// when the operand is already nullish, so no node ever reaches the serializer.
const WRAPPED = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'];

function tripped(node, expected, fnName) {
  // Carries ONLY the short summary; `actual`/`expected` stay undefined, so the
  // node's circular ownerDocument/Window graph never crosses the child-process
  // boundary.
  return new assertObj.AssertionError({
    message: `dom-assert tripwire: a DOM node reached assert.${fnName} — `
      + `expected ${expected === null ? 'null' : 'undefined'}, found ${describeFound(node)}. `
      + 'Use assertNull/assertUndefined from tests/dom-assert.mjs.',
    stackStartFn: tripped,
  });
}

function wrap(orig, fnName) {
  // A `function` expression forwarding `arguments`, never named parameters:
  // `orig(a, b, m)` would turn `assert.equal(1)` into `assert.equal(1, undefined)`
  // and lose ERR_MISSING_ARGS. Everything that is not node-vs-nullish returns
  // to the original untouched.
  const wrapped = function () {
    if (arguments.length >= 2) {
      const a = arguments[0], b = arguments[1];
      if (a === null || a === undefined) {
        if (isDomNode(b)) throw tripped(b, a, fnName);
      } else if (b === null || b === undefined) {
        if (isDomNode(a)) throw tripped(a, b, fnName);
      }
    }
    return orig.apply(this, arguments);
  };
  wrapped.__domTripwire = true;
  return wrapped;
}

// Idempotent: the marker property is the guard against double-wrapping, and is
// also what T7 asserts on so the tripwire test cannot pass vacuously.
export function installTripwire() {
  // `assert.strict` is the default export of `node:assert/strict` and carries
  // its own copies of these properties, so both objects need patching. Where
  // the two share a function reference the marker check makes the second a
  // no-op.
  for (const target of [assertObj, assertObj.strict]) {
    for (const k of WRAPPED) {
      const orig = target[k];
      if (typeof orig !== 'function' || orig.__domTripwire) continue;
      target[k] = wrap(orig, k);
    }
  }
}

installTripwire();
