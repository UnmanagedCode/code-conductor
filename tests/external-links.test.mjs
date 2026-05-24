import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModule() {
  return import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'external-links.js')).href);
}

// Build a synthetic window with a stub matchMedia, stub window.open that
// records calls our handler makes (filtered by the noopener,noreferrer feature
// string so we don't capture happy-dom's own default-action calls), and a stub
// for navigation. Click events are dispatched on a real happy-dom document so
// `closest('a')` / event bubbling work like in a browser.
function setup({ standalone }) {
  const window = new Window({ url: 'http://localhost/' });
  const document = window.document;
  window.matchMedia = (query) => ({
    matches: query === '(display-mode: standalone)' ? standalone : false,
    media: query,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  });
  const ourOpenCalls = [];
  const origOpen = window.open;
  window.open = function (...args) {
    // Our handler always passes 'noopener,noreferrer'; happy-dom's default
    // anchor action does not. Filter so we only see deliberate calls.
    if (args[2] === 'noopener,noreferrer') {
      ourOpenCalls.push(args);
      return {};
    }
    return origOpen ? origOpen.apply(this, args) : null;
  };
  return { window, document, ourOpenCalls };
}

function dispatchAnchorClick(document, anchor, { ctrlKey = false } = {}) {
  document.body.appendChild(anchor);
  const event = new document.defaultView.MouseEvent('click', {
    bubbles: true, cancelable: true, button: 0, ctrlKey,
  });
  anchor.dispatchEvent(event);
  return event;
}

test('external-links: standalone mode routes target=_blank through window.open', async () => {
  const { window, document, ourOpenCalls } = setup({ standalone: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, true);
  assert.equal(ourOpenCalls.length, 1);
  assert.deepEqual(ourOpenCalls[0], ['https://example.com/', '_blank', 'noopener,noreferrer']);
});

test('external-links: browser (non-standalone) mode leaves clicks alone', async () => {
  const { window, document, ourOpenCalls } = setup({ standalone: false });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
});

test('external-links: modifier click is not intercepted', async () => {
  const { window, document, ourOpenCalls } = setup({ standalone: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a, { ctrlKey: true });

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
});

test('external-links: non-_blank links pass through', async () => {
  const { window, document, ourOpenCalls } = setup({ standalone: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', '/foo');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
});

test('external-links: unsafe schemes are ignored', async () => {
  const { window, document, ourOpenCalls } = setup({ standalone: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'javascript:alert(1)');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
});
