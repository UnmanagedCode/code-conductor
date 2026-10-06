// WHAT THE PATH PICKER PROMISES (public/pathPicker.js), driven through the real
// module in happy-dom with a scripted `/api/fs/dirs` and fake timers.
//
// The input stays a plain text field; the list is a helper. Most of this file
// pins the three things that make a debounced, cached, cancellable fetch easy
// to get subtly wrong: no request until the debounce fires, no request at all
// inside an already-loaded directory, and a stale response never rendering.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { fakeTimers } from './composerDraftsHarness.mjs';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const { splitPath, installPathPicker, PATH_PICKER_DEBOUNCE_MS } =
  await import(pathToFileURL(path.join(PUB, 'pathPicker.js')).href);

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const ok = (entries, extra = {}) => ({ ok: true, system: 'local', remoteId: null, path: '/x', entries, links: [], truncated: false, max: 1000, ...extra });

// `script(url)` returns the response body, or a promise of it for a held request.
function boot({ script = () => ok([]), placement = { system: null, remoteId: null } } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = '<input id="p" /><ul id="l" hidden></ul><p id="n"></p>';
  const input = window.document.getElementById('p');
  const list = window.document.getElementById('l');
  const note = window.document.getElementById('n');
  const timers = fakeTimers();
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = { url: String(url), signal: opts.signal, params: new URL(url, 'http://localhost').searchParams };
    requests.push(req);
    const body = await script(req);
    if (body instanceof Error) throw body;
    if (body?.httpStatus) return { ok: false, status: body.httpStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  let where = placement;
  const picker = installPathPicker({ input, list, note, getPlacement: () => where, timers });
  const type = async (v, { settle = true } = {}) => {
    input.value = v;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    if (settle) { timers.fireAll(); await tick(); }
  };
  const key = (k, extra = {}) => {
    const e = new window.KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...extra });
    input.dispatchEvent(e);
    return e;
  };
  const items = () => [...list.querySelectorAll('li')].map(li => li.textContent);
  return { window, input, list, note, timers, requests, picker, type, key, items, setPlacement: p => { where = p; } };
}

describe('splitPath', () => {
  for (const [v, want] of [
    ['/', { dir: '/', dirSlash: '/', prefix: '' }],
    ['/a', { dir: '/', dirSlash: '/', prefix: 'a' }],
    ['/a/', { dir: '/a', dirSlash: '/a/', prefix: '' }],
    ['/a/b/pre', { dir: '/a/b', dirSlash: '/a/b/', prefix: 'pre' }],
    ['', null],
    ['rel/dir', null],
    ['C:\\Users\\x', null],
  ]) {
    test(JSON.stringify(v), () => assert.deepEqual(splitPath(v), want));
  }
});

describe('request shape and debounce', () => {
  test('nothing is fetched before the debounce fires, and three keystrokes in one directory make one request', async () => {
    const t = boot();
    await t.type('/a', { settle: false });
    await t.type('/ab', { settle: false });
    await t.type('/abc', { settle: false });
    await tick();
    assert.equal(t.requests.length, 0);
    assert.equal(t.timers.count, 1, 'one pending debounce, not three');
    t.timers.fireAll();
    await tick();
    assert.equal(t.requests.length, 1);
    assert.ok(PATH_PICKER_DEBOUNCE_MS > 0);
  });

  test('a local placement sends only path', async () => {
    const t = boot();
    await t.type('/srv/x');
    assert.equal(t.requests[0].url, '/api/fs/dirs?path=%2Fsrv');
  });

  test('a system and remote are sent when chosen', async () => {
    const t = boot({ placement: { system: 'prod-box', remoteId: 'r1' } });
    await t.type('/srv/x');
    assert.equal(t.requests[0].params.get('system'), 'prod-box');
    assert.equal(t.requests[0].params.get('remoteId'), 'r1');
    assert.equal(t.requests[0].params.get('path'), '/srv');
  });

  test('a non-absolute value makes no request and clears the list', async () => {
    const t = boot();
    await t.type('rel');
    await t.type('C:\\x');
    assert.equal(t.requests.length, 0);
    assert.equal(t.timers.count, 0);
    assert.equal(t.list.hidden, true);
  });
});

describe('cache', () => {
  test('typing within a loaded directory re-filters with no timer and no request', async () => {
    const t = boot({ script: () => ok(['alpha', 'alps', 'beta']) });
    await t.type('/');
    assert.deepEqual(t.items(), ['alpha', 'alps', 'beta']);
    await t.type('/al', { settle: false });
    assert.equal(t.timers.count, 0);
    assert.equal(t.requests.length, 1);
    assert.deepEqual(t.items(), ['alpha', 'alps'], 're-filtered synchronously');
  });

  test('the key includes the placement', async () => {
    const t = boot({ script: () => ok(['a']) });
    await t.type('/');
    t.setPlacement({ system: 'box', remoteId: null });
    await t.type('/x', { settle: false });
    await t.type('/', { settle: false });
    t.timers.fireAll();
    await tick();
    assert.equal(t.requests.length, 2, 'the same directory on another system is a different listing');
  });

  test('the key includes the remoteId: another remote of the same system and directory is its own fetch, with no reset between', async () => {
    const t = boot({ script: () => ok(['a']) });
    t.setPlacement({ system: 'box', remoteId: 'r1' });
    await t.type('/srv/x');
    t.setPlacement({ system: 'box', remoteId: 'r2' });
    await t.type('/srv/x');
    assert.equal(t.requests.length, 2);
    assert.equal(t.requests[0].params.get('remoteId'), 'r1');
    assert.equal(t.requests[1].params.get('remoteId'), 'r2');
    t.setPlacement({ system: 'box', remoteId: 'r1' });
    await t.type('/srv/x', { settle: false });
    assert.equal(t.timers.count, 0);
    assert.equal(t.requests.length, 2, 'and each remote keeps its own cached listing');
  });

  test('reset() clears the cache and aborts the in-flight request', async () => {
    let release;
    const t = boot({ script: req => (req.params.get('path') === '/slow' ? new Promise(r => { release = () => r(ok(['z'])); }) : ok(['a'])) });
    await t.type('/');
    t.picker.reset();
    assert.equal(t.list.hidden, true);
    await t.type('/');
    assert.equal(t.requests.length, 2, 'the same directory is fetched again after reset');
    await t.type('/slow/x');
    const pending = t.requests.at(-1);
    t.picker.reset();
    assert.equal(pending.signal.aborted, true);
    release();
    await tick();
    assert.equal(t.list.hidden, true, 'a response that lands after reset renders nothing');
    assert.equal(t.note.textContent, '');
  });
});

describe('rendering', () => {
  test('dot-directories appear only when the prefix starts with a dot', async () => {
    const t = boot({ script: () => ok(['.git', '.hidden', 'src']) });
    await t.type('/');
    assert.deepEqual(t.items(), ['src']);
    await t.type('/.', { settle: false });
    assert.deepEqual(t.items(), ['.git', '.hidden']);
  });

  test('entries and unresolved links merge into one sorted list; links are marked', async () => {
    const t = boot({ script: () => ok(['b', 'd'], { links: ['a', 'c'] }) });
    await t.type('/');
    assert.deepEqual(t.items(), ['a', 'b', 'c', 'd']);
    const marked = [...t.list.querySelectorAll('li')].filter(li => li.className === 'path-completion-unresolved').map(li => li.textContent);
    assert.deepEqual(marked, ['a', 'c']);
    assert.match(t.list.querySelector('li').title, /not checked/);
    await t.type('/c', { settle: false });
    assert.deepEqual(t.items(), ['c'], 'an unresolved link filters like any other name');
  });

  test('a truncated listing names the response max in the note', async () => {
    const t = boot({ script: () => ok(['a'], { truncated: true, max: 321 }) });
    await t.type('/');
    assert.match(t.note.textContent, /more than 321 directories/);
  });

  test('the input opts out of browser autocomplete and spellcheck and declares a list', async () => {
    const t = boot();
    assert.equal(t.input.getAttribute('autocomplete'), 'off');
    assert.equal(t.input.getAttribute('spellcheck'), 'false');
    assert.equal(t.input.getAttribute('aria-autocomplete'), 'list');
  });

  test('the note says Listing <dir>… while the request is pending', async () => {
    let release;
    const t = boot({ script: () => new Promise(r => { release = () => r(ok(['a'])); }) });
    await t.type('/srv/x');
    assert.equal(t.note.textContent, 'Listing /srv…');
    release();
    await tick();
    assert.equal(t.note.textContent, '');
  });

  test('every option carries role, id and the combobox wiring', async () => {
    const t = boot({ script: () => ok(['a', 'b']) });
    await t.type('/');
    assert.equal(t.input.getAttribute('role'), 'combobox');
    assert.equal(t.input.getAttribute('aria-controls'), 'l');
    assert.equal(t.input.getAttribute('aria-expanded'), 'true');
    assert.deepEqual([...t.list.children].map(li => [li.getAttribute('role'), li.id]), [['option', 'l-opt-0'], ['option', 'l-opt-1']]);
  });

  test('names are text, never markup', async () => {
    const t = boot({ script: () => ok(['<b>x</b>']) });
    await t.type('/');
    assert.ok(t.list.querySelector('b') === null, 'no element was parsed out of the name');
    assert.deepEqual(t.items(), ['<b>x</b>']);
  });
});

describe('stale responses', () => {
  test('a pending request is aborted when the user moves to another directory, and its late answer renders nothing', async () => {
    let releaseA;
    const t = boot({ script: req => (req.params.get('path') === '/a' ? new Promise(r => { releaseA = () => r(ok(['from-a'])); }) : ok(['from-b'])) });
    await t.type('/a/x');
    const reqA = t.requests[0];
    await t.type('/b/f');
    assert.equal(reqA.signal.aborted, true);
    assert.deepEqual(t.items(), ['from-b']);
    releaseA();
    await tick();
    assert.deepEqual(t.items(), ['from-b']);
  });

  test('an answer for a directory the input has left is cached, not rendered', async () => {
    let releaseA;
    const t = boot({ script: req => new Promise(r => { if (req.params.get('path') === '/a') releaseA = () => r(ok(['from-a'])); else r(ok(['x'])); }) });
    await t.type('/a/q');
    await t.type('/zzz', { settle: false });
    releaseA();
    await tick();
    assert.equal(t.list.hidden, true);
  });
});

describe('keyboard and pointer', () => {
  test('Tab completes the first item when none is active, prevents default and fires input', async () => {
    const t = boot({ script: () => ok(['alpha', 'beta']) });
    await t.type('/');
    let inputs = 0;
    t.input.addEventListener('input', () => inputs++);
    const e = t.key('Tab');
    assert.equal(e.defaultPrevented, true);
    assert.equal(t.input.value, '/alpha/');
    assert.equal(inputs, 1);
  });

  test('Tab completes the ACTIVE option, not the first', async () => {
    const t = boot({ script: () => ok(['a', 'b', 'c']) });
    await t.type('/');
    t.key('ArrowDown');
    t.key('ArrowDown');
    t.key('Tab');
    assert.equal(t.input.value, '/b/');
  });

  test('completing lists the new directory next', async () => {
    const t = boot({ script: req => ok(req.params.get('path') === '/' ? ['alpha'] : ['inner']) });
    await t.type('/');
    t.key('Tab');
    t.timers.fireAll();
    await tick();
    assert.equal(t.requests.at(-1).params.get('path'), '/alpha');
    assert.deepEqual(t.items(), ['inner']);
  });

  test('arrows move the selection with wrap-around, Enter completes the active item', async () => {
    const t = boot({ script: () => ok(['a', 'b', 'c']) });
    await t.type('/');
    const selected = () => [...t.list.children].map(li => li.getAttribute('aria-selected'));
    t.key('ArrowDown');
    assert.deepEqual(selected(), ['true', 'false', 'false']);
    t.key('ArrowUp');
    assert.deepEqual(selected(), ['false', 'false', 'true'], 'up from the first wraps to the last');
    assert.equal(t.input.getAttribute('aria-activedescendant'), 'l-opt-2');
    t.key('ArrowDown');
    assert.deepEqual(selected(), ['true', 'false', 'false'], 'down from the last wraps to the first');
    t.key('ArrowDown');
    const e = t.key('Enter');
    assert.equal(e.defaultPrevented, true);
    assert.equal(t.input.value, '/b/');
  });

  test('ArrowUp from no active item selects the last; ArrowDown from none selects the first', async () => {
    const up = boot({ script: () => ok(['a', 'b', 'c']) });
    await up.type('/');
    up.key('ArrowUp');
    assert.deepEqual([...up.list.children].map(li => li.getAttribute('aria-selected')), ['false', 'false', 'true']);
    const down = boot({ script: () => ok(['a', 'b', 'c']) });
    await down.type('/');
    down.key('ArrowDown');
    assert.deepEqual([...down.list.children].map(li => li.getAttribute('aria-selected')), ['true', 'false', 'false']);
  });

  test('Shift+Tab is left to the browser: not prevented, value unchanged', async () => {
    const t = boot({ script: () => ok(['a']) });
    await t.type('/');
    const e = t.key('Tab', { shiftKey: true });
    assert.equal(e.defaultPrevented, false);
    assert.equal(t.input.value, '/');
  });

  test('Enter with no active item is left alone so the form still submits', async () => {
    const t = boot({ script: () => ok(['a']) });
    await t.type('/');
    const e = t.key('Enter');
    assert.equal(e.defaultPrevented, false);
    assert.equal(t.input.value, '/');
  });

  test('Escape closes an open list and is stopped; with the list closed it is not prevented', async () => {
    const t = boot({ script: () => ok(['a']) });
    await t.type('/');
    let reachedDialog = false;
    t.window.document.body.addEventListener('keydown', () => { reachedDialog = true; });
    const open = t.key('Escape');
    assert.equal(open.defaultPrevented, true);
    assert.equal(reachedDialog, false, 'the dialog never hears the Escape that closed the list');
    assert.equal(t.list.hidden, true);
    const closed = t.key('Escape');
    assert.equal(closed.defaultPrevented, false);
    assert.equal(reachedDialog, true);
  });

  test('clicking an option completes it; mousedown keeps focus in the input', async () => {
    const t = boot({ script: () => ok(['a', 'b']) });
    await t.type('/');
    const down = new t.window.MouseEvent('mousedown', { cancelable: true, bubbles: true });
    t.list.children[1].dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    t.list.children[1].dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
    assert.equal(t.input.value, '/b/');
  });

  test('blur closes the list but keeps the cache', async () => {
    const t = boot({ script: () => ok(['a']) });
    await t.type('/');
    t.input.dispatchEvent(new t.window.Event('blur'));
    assert.equal(t.list.hidden, true);
    await t.type('/', { settle: false });
    assert.equal(t.requests.length, 1);
    assert.deepEqual(t.items(), ['a']);
  });
});

describe('failures', () => {
  test('a refusal about the path shows its reason, closes the list, is cached, and leaves the input editable', async () => {
    const t = boot({ script: () => ({ ok: false, code: 'EACCES', reason: "cannot read '/srv'" }) });
    await t.type('/srv/x');
    assert.equal(t.note.textContent, "cannot read '/srv'");
    assert.equal(t.list.hidden, true);
    await t.type('/srv/xy', { settle: false });
    assert.equal(t.requests.length, 1, 'the refused directory is not asked again');
    assert.equal(t.note.textContent, "cannot read '/srv'");
    assert.equal(t.input.value, '/srv/xy');
  });

  describe('transient refusals are shown but not cached', () => {
    for (const code of ['LIST_TIMEOUT', 'ETIMEDOUT', 'ETRANSPORT', 'SYSTEM_UNREACHABLE']) {
      test(code, async () => {
        let n = 0;
        const t = boot({ script: () => (++n === 1 ? { ok: false, code, reason: `slow: ${code}` } : ok(['a'])) });
        await t.type('/srv/x');
        assert.equal(t.note.textContent, `slow: ${code}`);
        await t.type('/srv/', { settle: false });
        t.timers.fireAll();
        await tick();
        assert.equal(t.requests.length, 2, 'retyping in that directory retries');
        assert.deepEqual(t.items(), ['a']);
      });
    }
  });

  test('a refusal without a reason still says something, never the bare code', async () => {
    const t = boot({ script: () => ({ ok: false, code: 'ENOENT' }) });
    await t.type('/nope/x');
    assert.equal(t.note.textContent, 'could not list /nope.');
  });

  test('an HTTP error puts up a note and is not cached', async () => {
    let n = 0;
    const t = boot({ script: () => (++n === 1 ? { httpStatus: 500 } : ok(['a'])) });
    await t.type('/');
    assert.match(t.note.textContent, /Could not list \/ \(HTTP 500\)/);
    await t.type('/', { settle: false });
    t.timers.fireAll();
    await tick();
    assert.equal(t.requests.length, 2);
    assert.deepEqual(t.items(), ['a']);
    assert.equal(t.note.textContent, '');
  });

  test('a network error puts up a note and is not cached', async () => {
    let n = 0;
    const t = boot({ script: () => (++n === 1 ? new Error('offline') : ok(['a'])) });
    await t.type('/');
    assert.match(t.note.textContent, /offline/);
    await t.type('/q', { settle: false });
    t.timers.fireAll();
    await tick();
    assert.equal(t.requests.length, 2);
  });
});
