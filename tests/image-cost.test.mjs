// Unit coverage of src/imageCost.ts: Anthropic's vision token rule and the
// image-header sniffing that feeds it.
//
// The cost figures are Anthropic's published high-res-tier table
// (https://platform.claude.com/docs/en/build-with-claude/vision), not values
// derived from the implementation. The fixtures under tests/fixtures/prune-images
// are real files written by ImageMagick; their dimensions are non-square so a
// width/height swap in a parser is caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageTokenCost, imageDimensions, IMAGE_MAX_TOKENS } from '../src/imageCost.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'prune-images');
const fixture = (name) => fs.readFile(path.join(FIXTURES, name));

test('imageTokenCost matches Anthropic\'s published high-res table', async (t) => {
  const rows = [
    [200, 200, 64],
    [1000, 1000, 1296],
    [1092, 1092, 1521],
    [1920, 1080, 2691],
    [2000, 1500, 3888],
    // Resized to 2576×1449 before tokenizing.
    [3840, 2160, 4784],
  ];
  for (const [w, h, tokens] of rows) {
    await t.test(`${w}×${h} → ${tokens}`, () => {
      assert.equal(imageTokenCost(w, h), tokens);
    });
  }
});

test('the visual-token budget bounds a square image the edge limit would allow', () => {
  // 69² = 4761 ≤ 4784 < 70², so the budget, not the edge limit, picks a long
  // edge of 69·28 = 1932 px.
  assert.equal(imageTokenCost(3000, 3000), 4761);
  // The cost is symmetric under a width/height swap.
  assert.equal(imageTokenCost(2160, 3840), 4784);
  assert.ok(imageTokenCost(8000, 8000) <= IMAGE_MAX_TOKENS);
  assert.ok(imageTokenCost(20000, 300) <= IMAGE_MAX_TOKENS);
});

test('imageDimensions reads each supported format from real bytes', async (t) => {
  const cases = [
    ['screenshot-1280x800.png', 1280, 800],
    ['large-3840x2160.png', 3840, 2160],
    ['icon-16x16.png', 16, 16],
    ['baseline-210x140.jpg', 210, 140],
    ['progressive-210x140.jpg', 210, 140],
    ['anim-210x140.gif', 210, 140],
    ['lossy-210x140.webp', 210, 140],
    ['lossless-210x140.webp', 210, 140],
    ['alpha-210x140.webp', 210, 140],
  ];
  for (const [name, width, height] of cases) {
    await t.test(name, async () => {
      assert.deepEqual(imageDimensions(await fixture(name)), { width, height });
    });
  }
});

test('imageDimensions refuses truncated or foreign bytes', async (t) => {
  await t.test('a PNG cut inside IHDR', async () => {
    assert.equal(imageDimensions((await fixture('screenshot-1280x800.png')).subarray(0, 20)), null);
  });
  await t.test('a JPEG cut before its SOF marker', async () => {
    const jpg = await fixture('baseline-210x140.jpg');
    const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
    assert.ok(sof > 2, 'fixture carries a SOF0 marker');
    assert.equal(imageDimensions(jpg.subarray(0, sof)), null);
  });
  await t.test('a WebP cut inside its VP8 header', async () => {
    assert.equal(imageDimensions((await fixture('lossy-210x140.webp')).subarray(0, 27)), null);
  });
  await t.test('bytes with no image signature', () => {
    assert.equal(imageDimensions(Buffer.from('not an image')), null);
  });
});
