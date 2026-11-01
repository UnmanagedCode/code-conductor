// @vitest-environment node
// The committed icons in web/public against the art module that
// scripts/build-icons.mjs writes them from: icon.svg is the module's text, and
// every PNG has the pixel size its name and the manifest promise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { iconSvg } from './logoArt';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public');
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f));
/** A PNG's IHDR width and height. */
const pngSize = (f: string) => {
  const png = read(f);
  expect(png.subarray(1, 4).toString('latin1'), `${f} is a PNG`).toBe('PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

describe('web/public icons', () => {
  it('icon.svg is exactly what logoArt.ts builds', () => {
    // Invariant: the committed PWA icon cannot drift from the drawing; rerun scripts/build-icons.mjs after changing the art.
    expect(read('icon.svg').toString('utf8')).toBe(iconSvg());
  });

  it('icon.svg carries no style and no animation', () => {
    // Invariant: the static icon is static, with nothing a page or launcher could animate.
    const svg = read('icon.svg').toString('utf8');
    expect(svg).not.toMatch(/<style/i);
    expect(svg).not.toMatch(/animation/i);
  });

  it('each PNG is the size it is linked at: the favicons, the apple-touch icon and every manifest PNG', () => {
    // Invariant: favicon-16 is 16px, favicon-32 32px, apple-touch-icon 180px, and each manifest PNG matches its sizes.
    expect(pngSize('favicon-16.png')).toEqual([16, 16]);
    expect(pngSize('favicon-32.png')).toEqual([32, 32]);
    expect(pngSize('apple-touch-icon.png')).toEqual([180, 180]);
    const icons = (JSON.parse(read('manifest.webmanifest').toString('utf8')).icons as { src: string; sizes: string }[])
      .filter((i) => i.src.endsWith('.png'));
    expect(icons.length, 'fixture check: the manifest lists PNGs').toBeGreaterThan(0);
    for (const { src, sizes } of icons) expect(pngSize(src).join('x'), src).toBe(sizes);
  });
});
