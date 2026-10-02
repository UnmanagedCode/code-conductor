// The touch-primary query shared by public/layout.js and public/styles.css,
// pinned the way tests/header-compact-css.test.mjs pins MOBILE_LAYOUT_QUERY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { TOUCH_QUERY } from '../public/layout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = await fs.readFile(path.resolve(__dirname, '..', 'public', 'styles.css'), 'utf8');

// Invariant: the JS touch signal and the stylesheet's hover-capability blocks
// are one value — styles.css has an `@media` block whose query is exactly
// TOUCH_QUERY.
test('styles.css has an @media block whose query is TOUCH_QUERY', () => {
  assert.ok(css.includes(`@media ${TOUCH_QUERY} {`), `styles.css has an @media ${TOUCH_QUERY} block`);
});

// Invariant: every hover-capability `@media` query in styles.css is TOUCH_QUERY,
// so no block follows a different touch signal than the one promptFocus.js uses.
test('every @media query in styles.css that tests hover is TOUCH_QUERY', () => {
  const hoverQueries = [...css.matchAll(/@media\s+([^{]*hover[^{]*)\{/g)].map((m) => m[1].trim());
  assert.ok(hoverQueries.length > 0, 'found the hover @media blocks');
  for (const q of hoverQueries) assert.equal(q, TOUCH_QUERY);
});
