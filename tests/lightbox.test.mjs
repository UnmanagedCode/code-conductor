import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function setup() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.MouseEvent = window.MouseEvent;
  // Fresh module each setup so installLightbox() doesn't share state across tests.
  const url = pathToFileURL(path.resolve(__dirname, '..', 'public', 'lightbox.js')).href + '?t=' + Math.random();
  return { window, document: window.document, mod: await import(url) };
}

function click(node) {
  const e = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  node.dispatchEvent(e);
  return e;
}

test('lightbox: clicking a .tool-result-img opens the overlay with the same src', async () => {
  const { document, mod } = await setup();
  mod.installLightbox();
  const img = document.createElement('img');
  img.className = 'tool-result-img';
  img.setAttribute('src', 'data:image/png;base64,AAAA');
  document.body.appendChild(img);

  const e = click(img);
  assert.equal(e.defaultPrevented, true, 'click should be prevented');
  const backdrop = document.querySelector('.lightbox-backdrop');
  assert.ok(backdrop);
  assert.equal(backdrop.hidden, false);
  const big = backdrop.querySelector('img.lightbox-img');
  assert.ok(big);
  assert.equal(big.getAttribute('src'), 'data:image/png;base64,AAAA');
  assert.equal(document.body.classList.contains('lightbox-open'), true);
});

test('lightbox: clicking the backdrop closes the overlay', async () => {
  const { document, mod } = await setup();
  mod.installLightbox();
  const img = document.createElement('img');
  img.className = 'tool-result-img';
  img.setAttribute('src', 'data:image/png;base64,BBBB');
  document.body.appendChild(img);
  click(img);
  const backdrop = document.querySelector('.lightbox-backdrop');
  assert.equal(backdrop.hidden, false);
  click(backdrop);
  assert.equal(backdrop.hidden, true);
  assert.equal(document.body.classList.contains('lightbox-open'), false);
});

test('lightbox: Escape closes the overlay', async () => {
  const { document, window, mod } = await setup();
  mod.installLightbox();
  const img = document.createElement('img');
  img.className = 'tool-result-img';
  img.setAttribute('src', 'data:image/png;base64,CCCC');
  document.body.appendChild(img);
  click(img);
  const backdrop = document.querySelector('.lightbox-backdrop');
  assert.equal(backdrop.hidden, false);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(backdrop.hidden, true);
});

test('lightbox: clicking inside .md img opens the overlay', async () => {
  const { document, mod } = await setup();
  mod.installLightbox();
  const md = document.createElement('div');
  md.className = 'md';
  const img = document.createElement('img');
  img.setAttribute('src', 'https://example.com/x.png');
  md.appendChild(img);
  document.body.appendChild(md);
  click(img);
  const big = document.querySelector('.lightbox-backdrop img.lightbox-img');
  assert.ok(big);
  assert.equal(big.getAttribute('src'), 'https://example.com/x.png');
});

test('lightbox: tapping the big image toggles full-res zoom (does not close)', async () => {
  const { document, mod } = await setup();
  mod.installLightbox();
  const img = document.createElement('img');
  img.className = 'tool-result-img';
  img.setAttribute('src', 'data:image/png;base64,DDDD');
  document.body.appendChild(img);
  click(img);
  const backdrop = document.querySelector('.lightbox-backdrop');
  const big = document.querySelector('.lightbox-img');
  // Opens fit-to-screen.
  assert.equal(big.classList.contains('zoomed'), false);
  // First tap → 1:1 native resolution; overlay stays open.
  click(big);
  assert.equal(backdrop.hidden, false, 'tapping the image must not close the overlay');
  assert.equal(big.classList.contains('zoomed'), true);
  assert.equal(backdrop.classList.contains('zoomed'), true);
  // Second tap → back to fit.
  click(big);
  assert.equal(backdrop.hidden, false);
  assert.equal(big.classList.contains('zoomed'), false);
});

test('lightbox: backdrop click still closes after zooming', async () => {
  const { document, mod } = await setup();
  mod.installLightbox();
  const img = document.createElement('img');
  img.className = 'tool-result-img';
  img.setAttribute('src', 'data:image/png;base64,EEEE');
  document.body.appendChild(img);
  click(img);
  const backdrop = document.querySelector('.lightbox-backdrop');
  const big = document.querySelector('.lightbox-img');
  click(big); // zoom in
  assert.equal(backdrop.classList.contains('zoomed'), true);
  click(backdrop); // click outside the image → close
  assert.equal(backdrop.hidden, true);
  // Zoom state resets on close so the next open starts fit-to-screen.
  assert.equal(backdrop.classList.contains('zoomed'), false);
});

test('lightbox: ignores clicks on unrelated images', async () => {
  const { document, mod } = await setup();
  mod.installLightbox();
  const img = document.createElement('img');
  img.setAttribute('src', '/icon.png');
  document.body.appendChild(img); // not inside .md, no special class
  click(img);
  assert.equal(document.querySelector('.lightbox-backdrop'), null);
});
