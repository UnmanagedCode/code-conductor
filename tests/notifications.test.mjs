import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { shouldNotify, summarizeOpenNotifications } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'notifications.js')).href);

test('shouldNotify: respects global toggle', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: false, mutedInstance: false, documentHidden: true, isError: false }), false);
});

test('shouldNotify: requires granted permission', () => {
  assert.equal(shouldNotify({ permission: 'denied', globalEnabled: true, mutedInstance: false, documentHidden: true, isError: false }), false);
  assert.equal(shouldNotify({ permission: 'default', globalEnabled: true, mutedInstance: false, documentHidden: true, isError: false }), false);
});

test('shouldNotify: muted instance suppresses', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: true, documentHidden: true, isError: false }), false);
});

test('shouldNotify: only fires when tab is hidden (for non-error turns)', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: false, documentHidden: false, isError: false }), false);
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: false, documentHidden: true, isError: false }), true);
});

test('shouldNotify: errors notify even when tab is visible', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: false, documentHidden: false, isError: true }), true);
});

test('summarizeOpenNotifications: empty tray → no summary', () => {
  assert.deepEqual(summarizeOpenNotifications([]), { shouldFire: false });
  assert.deepEqual(summarizeOpenNotifications(null), { shouldFire: false });
});

test('summarizeOpenNotifications: single instance → no summary', () => {
  const open = [{ tag: 'instance:a', data: { project: 'projA' } }];
  assert.deepEqual(summarizeOpenNotifications(open), { shouldFire: false });
});

test('summarizeOpenNotifications: two instances → summary with both projects', () => {
  const open = [
    { tag: 'instance:a', data: { project: 'projA' } },
    { tag: 'instance:b', data: { project: 'projB' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '2 turns complete');
  assert.equal(out.body, 'projA, projB');
});

test('summarizeOpenNotifications: dedupes project names and truncates with overflow', () => {
  const open = [
    { tag: 'instance:a', data: { project: 'projA' } },
    { tag: 'instance:b', data: { project: 'projB' } },
    { tag: 'instance:c', data: { project: 'projC' } },
    { tag: 'instance:d', data: { project: 'projD' } },
    { tag: 'instance:e', data: { project: 'projA' } }, // duplicate name, distinct instance
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '5 turns complete');
  assert.equal(out.body, 'projA, projB, projC …+1 more');
});

test('summarizeOpenNotifications: ignores non-instance tags (cc-summary, foreign)', () => {
  const open = [
    { tag: 'instance:a', data: { project: 'projA' } },
    { tag: 'cc-summary' },
    { tag: 'instance:b', data: { project: 'projB' } },
    { tag: 'other:thing', data: { project: 'projZ' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '2 turns complete');
  assert.equal(out.body, 'projA, projB');
});

test('summarizeOpenNotifications: counts entries even when project data is missing', () => {
  const open = [
    { tag: 'instance:a' },
    { tag: 'instance:b', data: {} },
    { tag: 'instance:c', data: { project: 'projC' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '3 turns complete');
  assert.equal(out.body, 'projC');
});
