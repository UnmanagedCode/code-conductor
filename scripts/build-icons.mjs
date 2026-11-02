// Regenerates web/public's logo icons from web/src/components/logo/logoArt.ts:
// icon.svg as text, every PNG rasterised by Playwright's Chromium at its exact
// pixel size; docs/assets/logo-{light,dark}.svg as text, the README's lockup. Run `node scripts/build-icons.mjs` after changing the art, and
// commit the results. Exits non-zero when a self-check fails: a maskable icon
// drawing outside its safe zone, or a favicon with an opaque corner.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { artToSvgString, FAV32_BORDER, iconSvg, lockupSvg, pwaIconSvg, PWA_BACKGROUND, SMALL16 } from '../web/src/components/logo/logoArt.ts';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');

const icon = iconSvg();
/** [file, size, svg text, check] — `size` is the PNG's width and height. */
const PNGS = [
  ['favicon-16.png', 16, artToSvgString(SMALL16, { palette: 'light', size: 16 }), 'favicon'],
  ['favicon-32.png', 32, artToSvgString(FAV32_BORDER, { palette: 'light', size: 32 }), 'favicon'],
  ['icon-192.png', 192, icon, 'any'],
  ['icon-512.png', 512, icon, 'any'],
  ['apple-touch-icon.png', 180, pwaIconSvg('apple', 180), 'apple'],
  ['icon-maskable-192.png', 192, pwaIconSvg('maskable', 192), 'maskable'],
  ['icon-maskable-512.png', 512, pwaIconSvg('maskable', 512), 'maskable'],
];

const plate = PWA_BACKGROUND.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));

/** What is wrong with the `size`² RGBA `px` for `check`, or [] when nothing is. */
function problems(check, size, px) {
  const at = (x, y) => px.slice((y * size + x) * 4, (y * size + x) * 4 + 4);
  const out = [];
  if (check === 'favicon') {
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      if (at(x, y)[3] !== 0) out.push(`corner ${x},${y} is not transparent`);
    }
  }
  if (check === 'maskable') {
    // The safe zone: a circle of radius 0.4·size about the centre; outside it a launcher may crop.
    const r = size * 0.4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [R, G, B, A] = at(x, y);
        const plain = R === plate[0] && G === plate[1] && B === plate[2] && A === 255;
        if (!plain && Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > r) out.push(`pixel ${x},${y} outside the safe zone`);
      }
    }
  }
  return out;
}

fs.writeFileSync(path.join(PUBLIC, 'icon.svg'), icon);
fs.mkdirSync(DOCS, { recursive: true });
for (const palette of ['light', 'dark']) fs.writeFileSync(path.join(DOCS, `logo-${palette}.svg`), lockupSvg(palette));
const browser = await chromium.launch();
let failed = false;
try {
  for (const [file, size, svg, check] of PNGS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}body>svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
    fs.writeFileSync(path.join(PUBLIC, file), png);
    // Read the written bytes back, decoded by the browser, to check what ships.
    const px = await page.evaluate(async ([b64, n]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [img.naturalWidth, img.naturalHeight, ...ctx.getImageData(0, 0, n, n).data];
    }, [png.toString('base64'), size]);
    const [w, h] = px.splice(0, 2);
    const bad = [...(w === size && h === size ? [] : [`is ${w}x${h}`]), ...problems(check, size, px)];
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${file}${bad.length ? `: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` (+${bad.length - 5})` : ''}` : ''}`);
    if (bad.length) failed = true;
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('ok   icon.svg');
console.log('ok   docs/assets/logo-*.svg');
process.exit(failed ? 1 : 0);
