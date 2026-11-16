// The PWA icons' plate and colours: the maskable icon is the light mark on the
// app's light background, the manifest and icon.svg cannot drift from logoArt.ts,
// and the maskable ink bound is an enforced limit past the spec's 0.4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PWA_BACKGROUND, iconSvg, pwaIconSvg } from '../web/src/components/logo/logoArt.ts';
import { problems, MASKABLE_INK_RADIUS } from '../scripts/icon-checks.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the maskable icon is the light mark at 0.67 on #fcfbfa', () => {
  const svg = pwaIconSvg('maskable', 512);
  const rect = svg.match(/<rect\b[^>]*>/)[0];
  assert.match(rect, /fill="#fcfbfa"/);
  assert.doesNotMatch(rect, /\srx=/);
  const box = Math.round(512 * 0.67);
  const nested = svg.match(/<svg\b[^>]*\sx="[^"]*"[^>]*>/)[0];
  const num = (n) => Number(nested.match(new RegExp(`\\s${n}="([^"]*)"`))[1]);
  assert.equal(num('width'), box);
  assert.equal(num('height'), box);
  assert.equal(num('x'), (512 - box) / 2);
  assert.equal(num('y'), (512 - box) / 2);
  const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1].toLowerCase());
  assert.ok(fills.includes('#15171c'), 'light ink present');
  assert.ok(!fills.includes('#ffffff'), 'no dark-palette white');
});

test('the manifest and icon.svg cannot drift from logoArt.ts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.theme_color, PWA_BACKGROUND);
  assert.equal(manifest.background_color, PWA_BACKGROUND);
  assert.ok(fs.readFileSync(path.join(ROOT, 'web/public/icon.svg'), 'utf8') === iconSvg(), 'icon.svg is stale: rerun node scripts/build-icons.mjs');
});

const SIZE = 100;
const PLATE = [252, 251, 250];
/** A SIZE² RGBA image of opaque plate with one opaque non-plate pixel `rFrac`·SIZE right of the centre. */
function withInkAt(rFrac) {
  const px = [];
  for (let i = 0; i < SIZE * SIZE; i++) px.push(...PLATE, 255);
  const x = Math.round(SIZE / 2 + rFrac * SIZE);
  px.splice((50 * SIZE + x) * 4, 4, 0, 0, 0, 255);
  return px;
}

test('the maskable bound tolerates ink past 0.4 and flags ink past MASKABLE_INK_RADIUS', async (t) => {
  assert.ok(MASKABLE_INK_RADIUS > 0.43 && MASKABLE_INK_RADIUS < 0.45, 'bound sits between the two arms');
  await t.test('ink at 0.43·size passes', () => assert.deepEqual(problems('maskable', SIZE, withInkAt(0.43), PLATE), []));
  await t.test('ink at 0.45·size fails', () => {
    const out = problems('maskable', SIZE, withInkAt(0.45), PLATE);
    assert.equal(out.length, 1);
    assert.match(out[0], /outside the safe zone/);
  });
});

test('the favicon check flags an opaque corner only', () => {
  const opaque = withInkAt(0);
  assert.ok(problems('favicon', SIZE, opaque, PLATE).length > 0);
  assert.deepEqual(problems('favicon', SIZE, new Array(SIZE * SIZE * 4).fill(0), PLATE), []);
});
