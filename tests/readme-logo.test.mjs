// The README's logo: a <picture> offering a light and a dark source and an img
// fallback, every file it names a static, self-contained SVG GitHub renders
// as an image (no script, style, font, animation or external reference).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTES } from '../web/src/components/logo/logoArt.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const picture = (() => {
  const m = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').match(/<picture>[\s\S]*?<\/picture>/);
  assert.ok(m, 'README.md has a <picture>');
  return m[0];
})();
const tags = (name) => [...picture.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0]);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const BANNED = [/<script/i, /<style/i, /<text/i, /<tspan/i, /<font/i, /<foreignObject/i, /<image/i, /<use/i, /<animate/i, /<set\b/i, /font-family/i, /@import/i, /\bon\w+\s*=/i, /\bhref\s*=/i];

/** What stops `svg` rendering as a static, self-contained image on GitHub, or [] when nothing does. */
function problems(svg) {
  const out = [];
  if (!/<svg\b/.test(svg)) out.push('no <svg> root');
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) out.push('no SVG xmlns');
  for (const re of BANNED) if (re.test(svg)) out.push(`matches ${re}`);
  for (const [, ref] of svg.matchAll(/url\(([^)]*)\)/g)) {
    const id = ref.match(/^#(.+)$/)?.[1];
    if (!id) out.push(`url(${ref}) is not a local reference`);
    else if (!svg.includes(`id="${id}"`)) out.push(`url(#${id}) has no definition`);
  }
  return out;
}

test("the README's logo picture offers a light and a dark source and an img fallback with alt text", () => {
  // Invariant: GitHub's light and dark pages each get a matching source; a renderer without <picture> still gets a named image.
  const media = tags('source').map((t) => attr(t, 'media') ?? '');
  assert.ok(media.some((m) => m.includes('prefers-color-scheme: dark')), 'a dark source');
  assert.ok(media.some((m) => m.includes('prefers-color-scheme: light')), 'a light source');
  const [img] = tags('img');
  assert.ok(img, 'an <img> fallback');
  assert.ok(attr(img, 'alt'), 'alt text');
  assert.ok(attr(img, 'src'), 'a src');
});

test("every image the README's logo picture names exists and is a static, self-contained SVG GitHub can render", () => {
  // Invariant: a README logo file is a real static SVG with no text, font, animation or external reference; the checker itself flags each known-bad sample.
  const X = 'xmlns="http://www.w3.org/2000/svg"';
  for (const bad of [
    `<svg ${X}><text>x</text></svg>`, `<svg ${X}><script>1</script></svg>`, `<svg ${X}><animate/></svg>`,
    `<svg ${X}><path fill="url(#missing)"/></svg>`, `<svg ${X}><a href="https://x"/></svg>`, '<svg><path/></svg>',
  ]) assert.notDeepEqual(problems(bad), [], `positive control: ${bad}`);
  assert.deepEqual(problems(`<svg ${X}><defs><mask id="k0"/></defs><g mask="url(#k0)"/></svg>`), [], 'a clean sample passes');

  const files = [...picture.matchAll(/\b(?:srcset|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 2, 'fixture check: the picture names files');
  for (const rel of files) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} exists`);
    assert.deepEqual(problems(fs.readFileSync(file, 'utf8')), [], rel);
  }
});

test("the dark source names the dark-palette file, the light source and the img fallback the light-palette file", () => {
  // Invariant: each source's file is drawn in the ink of the scheme its media names (read from PALETTES), and the <img> fallback is the light file; swapped srcsets or one palette written into both files fail.
  const inkOf = (file) => {
    const svg = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const has = (palette) => svg.includes(`fill="${PALETTES[palette].ink}"`);
    return has('light') === has('dark') ? 'neither or both' : has('dark') ? 'dark' : 'light';
  };
  assert.notEqual(PALETTES.light.ink, PALETTES.dark.ink, 'fixture check: the palettes\' ink differs');
  const sourceFor = (scheme) => {
    const tag = tags('source').find((t) => (attr(t, 'media') ?? '').includes(`prefers-color-scheme: ${scheme}`));
    assert.ok(tag, `a ${scheme} source`);
    return attr(tag, 'srcset');
  };
  assert.equal(inkOf(sourceFor('dark')), 'dark', 'the dark source is drawn for dark');
  assert.equal(inkOf(sourceFor('light')), 'light', 'the light source is drawn for light');
  assert.equal(inkOf(attr(tags('img')[0], 'src')), 'light', 'the img fallback is drawn for light');
});
