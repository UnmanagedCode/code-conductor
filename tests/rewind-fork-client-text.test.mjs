// The UI half of the rewind/fork text guard: the server refuses a rewind/fork
// whose prompt at `userMessageIndex` does not replay to the clicked bubble's
// text, so the bubble must hand its echo's RAW `ev.text` to the click handlers,
// and sessionActions must POST it unchanged. The fixture text is markdown with
// surrounding whitespace, so neither the rendered text nor a trimmed copy can
// stand in for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const RAW_TEXT = '  **Refactor** the `parser`\n\n- keep tests green  ';

function setupWindow() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  return window;
}

test('a bubble\'s rewind and fork clicks pass the echo\'s raw text as the second argument', async () => {
  setupWindow();
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  document.body.innerHTML = '<div id="root"></div>';
  const clicks = [];
  const conv = new Conversation(document.getElementById('root'), {
    onRewind: (...args) => clicks.push(['rewind', ...args]),
    onFork: (...args) => clicks.push(['fork', ...args]),
  });
  conv.apply({ kind: 'user_echo', text: RAW_TEXT, userIndex: 7, _seq: 1, parentToolUseId: null });
  const bubble = document.querySelector('.msg.user');
  bubble.querySelector('.user-msg-rewind').click();
  bubble.querySelector('.user-msg-fork').click();
  assert.deepEqual(clicks, [['rewind', 7, RAW_TEXT], ['fork', 7, RAW_TEXT]]);
});

// Drives one sessionActions mutation with confirm() accepted; returns the
// requests it made.
async function runAction(name, args) {
  const window = setupWindow();
  globalThis.confirm = () => true;
  window.confirm = () => true;
  globalThis.alert = (m) => { throw new Error(`unexpected alert: ${m}`); };
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    const body = { ok: true, droppedText: 'x', instance: { id: 'new-inst' } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const { installSessionActions } = await import(
    pathToFileURL(path.join(PUB, 'sessionActions.js')).href + `?t=${Math.random()}`);
  const actions = installSessionActions({
    getActiveId: () => 'inst-1', setActiveId: () => {}, getInstances: () => [],
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: () => {}, sidebar: {}, clearUnread: () => {}, headerUpdate: () => {},
    deleteProjectDom: {},
  });
  await actions[name](...args);
  return requests;
}

test('rewindActiveSession POSTs {userMessageIndex, text} with the text unchanged', async () => {
  const requests = await runAction('rewindActiveSession', [7, RAW_TEXT]);
  assert.deepEqual(requests, [{ url: '/api/instances/inst-1/rewind', method: 'POST', body: { userMessageIndex: 7, text: RAW_TEXT } }]);
});

test('forkActiveSession POSTs {userMessageIndex, text} with the text unchanged', async () => {
  const requests = await runAction('forkActiveSession', [7, RAW_TEXT]);
  assert.deepEqual(requests[0], { url: '/api/instances/inst-1/fork', method: 'POST', body: { userMessageIndex: 7, text: RAW_TEXT } });
});
