// Shared harness for the one-row-header tests (header-compact*.test.mjs): the
// real index.html into happy-dom at a chosen viewport width, the real
// installHeader(), and the real ws.js over tests/fakeSocket.mjs so a click's
// asserted frame is the one that goes on the wire. The viewport width drives
// happy-dom's real matchMedia, so MOBILE_LAYOUT_QUERY evaluates for real.
//
// No `.test.mjs` suffix: tests/run.mjs must not run it as a test file.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { Window } from 'happy-dom';
import { installFakeSocket } from './fakeSocket.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUB = path.resolve(__dirname, '..', 'public');

const DOM_IDS = [
  'composer-input', 'mode-toggle', 'kill-btn', 'mute-btn', 'resume-btn', 'instance-title',
  'turn-indicator', 'ti-left', 'ti-dot', 'ti-label', 'ti-ellipsis', 'ti-interrupt-now',
  'ti-usage-slot', 'sync-btn', 'sync-menu-btn', 'debug-btn',
  'summarize-session-btn', 'rename-session-btn', 'change-model-btn', 'change-effort-btn',
  'session-stats-btn', 'prune-session-btn', 'auto-approve-plan-btn', 'playbook-enforcement-btn',
  'overflow-menu', 'overflow-toggle', 'overflow-panel',
];

export const SESSION = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', displayStatus: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false, temp: false,
};
export const WORKTREE = { worktreeName: 'feat', baseBranch: 'main' };

// A session in `status` (displayStatus follows it), with overrides.
export const session = (status, over = {}) => ({ ...SESSION, status, displayStatus: status, ...over });

// `conversation(document)`, when given, builds the conversation the header
// drives, once the window exists; the default is an inert stub.
export async function setupHeader({ width = 1024, conversation = null } = {}) {
  const sent = [];
  installFakeSocket(sent);
  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const window = new Window({ url: 'http://localhost/', width, height: 800 });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.location = window.location;
  window.document.documentElement.innerHTML = html;
  const document = window.document;

  const dom = {};
  for (const id of DOM_IDS) {
    const key = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    dom[key] = document.getElementById(id);
    assert.ok(dom[key], `dom.${key} must resolve to a real element from index.html`);
  }

  // ws.js is imported WITHOUT a cache-buster so it is the same module instance
  // header.js's `import { send } from './ws.js'` resolved to.
  const { connect } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);
  connect();
  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=${Math.random()}`);
  const { UsageTracker, RateLimitTracker } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);

  let instances = [];
  let activeId = null;
  const usageByInstance = new Map();
  const actions = [];
  const header = installHeader({
    dom,
    getActiveId: () => activeId,
    getInstances: () => instances,
    setActiveStatus: () => {},
    setActiveMode: () => {},
    getUsage: (id) => {
      if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
      return usageByInstance.get(id);
    },
    globalRLTracker: new RateLimitTracker(),
    getAccountUsage: () => null,
    getAccountUsageStale: () => false,
    composer: { disable() {}, set() {} },
    conversation: conversation ? conversation(document) : { setUserActionsEnabled() {}, setCallUsageVisible() {} },
    sessionActions: {
      syncWorktree: () => actions.push('sync'),
      respawnActive: () => actions.push('respawn'),
    },
  });

  return {
    dom, header, window, document, sent, actions,
    show(inst) { instances = [inst]; activeId = inst.id; header.update(); },
    deselect() { instances = []; activeId = null; header.update(); },
    // Resize the viewport; happy-dom's matchMedia then fires `change` listeners.
    async resize(w) {
      window.happyDOM.setViewport({ width: w });
      await new Promise(r => setImmediate(r));
    },
    // Where the control sits: 'bar' (in #instance-controls, outside ⋮), 'menu'
    // (inside the ⋮ panel), and whether the control itself is hidden.
    placement(el) {
      return el.closest('#overflow-panel') ? 'menu' : el.closest('#instance-controls') ? 'bar' : 'elsewhere';
    },
    framesOf: (t) => sent.filter(m => m.t === t),
  };
}

// The class lists of a line's chips, e.g. ['ih-chip ih-title', …].
export function lineClasses(dom, line) {
  const el = dom.instanceTitle.querySelector(`.ih-line-${line}`);
  return el ? [...el.children].map(c => c.className) : null;
}
