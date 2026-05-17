import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { shouldNotify } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'notifications.js')).href);

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
