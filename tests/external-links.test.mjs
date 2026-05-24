import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModule() {
  return import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'external-links.js')).href);
}

// Build a synthetic window with stubbed matchMedia, a configurable userAgent,
// an intercepted window.open (filtered by the 'noopener,noreferrer' feature
// string so happy-dom's own default-action calls don't show up), and a
// trackable location setter for the intent: redirect path.
function setup({ standalone, android = false }) {
  const window = new Window({ url: 'http://localhost/' });
  const document = window.document;
  window.matchMedia = (query) => ({
    matches: query === '(display-mode: standalone)' ? standalone : false,
    media: query,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  });
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get() {
      return android
        ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
        : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    },
  });
  const ourOpenCalls = [];
  const origOpen = window.open;
  window.open = function (...args) {
    if (args[2] === 'noopener,noreferrer') {
      ourOpenCalls.push(args);
      return {};
    }
    return origOpen ? origOpen.apply(this, args) : null;
  };
  // Track location assignments without actually navigating happy-dom.
  // We override `window.location` with a mock whose `.href` setter records
  // navigation attempts (rather than overriding `location` itself, since the
  // module assigns to `win.location.href`, not `win.location`).
  const locationAssignments = [];
  const mockLocation = {
    get href() { return 'http://localhost/'; },
    set href(v) { locationAssignments.push(v); },
  };
  Object.defineProperty(window, 'location', {
    configurable: true,
    get() { return mockLocation; },
  });
  return { window, document, ourOpenCalls, locationAssignments };
}

function dispatchAnchorClick(document, anchor, { ctrlKey = false } = {}) {
  document.body.appendChild(anchor);
  const event = new document.defaultView.MouseEvent('click', {
    bubbles: true, cancelable: true, button: 0, ctrlKey,
  });
  anchor.dispatchEvent(event);
  return event;
}

test('external-links: standalone + Android routes target=_blank through an intent: URL', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: true, android: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/path?q=1');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, true);
  assert.equal(ourOpenCalls.length, 0, 'window.open should not be used on Android — intent: only');
  assert.equal(locationAssignments.length, 1);
  const intent = locationAssignments[0];
  assert.match(intent, /^intent:\/\/example\.com\/path\?q=1#Intent;/);
  assert.match(intent, /;scheme=https;/);
  assert.match(intent, /;package=com\.android\.chrome;/);
  assert.doesNotMatch(intent, /S\.browser_fallback_url/);
  assert.match(intent, /;end$/);
});

test('external-links: standalone non-Android still falls back to window.open', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: true, android: false });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, true);
  assert.equal(ourOpenCalls.length, 1);
  assert.deepEqual(ourOpenCalls[0], ['https://example.com/', '_blank', 'noopener,noreferrer']);
  assert.equal(locationAssignments.length, 0);
});

test('external-links: browser (non-standalone) mode leaves clicks alone', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: false, android: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
  assert.equal(locationAssignments.length, 0);
});

test('external-links: modifier click is not intercepted', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: true, android: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a, { ctrlKey: true });

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
  assert.equal(locationAssignments.length, 0);
});

test('external-links: non-_blank links pass through', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: true, android: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', '/foo');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
  assert.equal(locationAssignments.length, 0);
});

test('external-links: unsafe schemes are ignored', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: true, android: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'javascript:alert(1)');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, false);
  assert.equal(ourOpenCalls.length, 0);
  assert.equal(locationAssignments.length, 0);
});

test('external-links: mailto: on Android uses window.open (intent: is http/https only)', async () => {
  const { window, document, ourOpenCalls, locationAssignments } = setup({ standalone: true, android: true });
  const mod = await loadModule();
  mod.installExternalLinkOpener({ doc: document, win: window });

  const a = document.createElement('a');
  a.setAttribute('href', 'mailto:hi@example.com');
  a.setAttribute('target', '_blank');
  const event = dispatchAnchorClick(document, a);

  assert.equal(event.defaultPrevented, true);
  assert.equal(locationAssignments.length, 0);
  assert.equal(ourOpenCalls.length, 1);
  assert.equal(ourOpenCalls[0][0], 'mailto:hi@example.com');
});

test('external-links: toIntentUrl encodes host, path, query, hash with chrome package', async () => {
  const mod = await loadModule();
  const url = new URL('https://example.com/a/b?c=1&d=2#frag');
  const intent = mod.toIntentUrl(url);
  assert.match(intent, /^intent:\/\/example\.com\/a\/b\?c=1&d=2#frag#Intent;/);
  assert.match(intent, /;scheme=https;/);
  assert.match(intent, /;package=com\.android\.chrome;/);
  assert.doesNotMatch(intent, /S\.browser_fallback_url/);
  assert.match(intent, /;end$/);
});

test('external-links: toIntentUrl handles loopback URLs with non-default port', async () => {
  const mod = await loadModule();
  const url = new URL('http://127.0.0.1:8765/r/path?x=1');
  const intent = mod.toIntentUrl(url);
  assert.match(intent, /^intent:\/\/127\.0\.0\.1:8765\/r\/path\?x=1#Intent;/);
  assert.match(intent, /;scheme=http;/);
  assert.match(intent, /;package=com\.android\.chrome;/);
  assert.doesNotMatch(intent, /S\.browser_fallback_url/);
  assert.match(intent, /;end$/);
});
