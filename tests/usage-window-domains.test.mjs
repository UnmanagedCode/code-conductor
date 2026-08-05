// Direct unit pins on the backend→usage-window-domain mapping
// (src/usageWindowDomains.ts, converted to type-safe TS in round 1).
// overage-backend-exempt.test.mjs pins the same mapping through the instance
// registry; this file pins the pure function itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_DOMAIN, usageDomainOfBackend, isMonitoredDomain } from '../src/usageWindowDomains.ts';

test('usageDomainOfBackend maps the claude backend (and empty/absent) to the anthropic domain', () => {
  assert.equal(ANTHROPIC_DOMAIN, 'anthropic');
  assert.equal(usageDomainOfBackend('claude'), 'anthropic');
  assert.equal(usageDomainOfBackend(undefined), 'anthropic');
  assert.equal(usageDomainOfBackend(''), 'anthropic');
});

test('usageDomainOfBackend namespaces every other backend — including one literally named anthropic', () => {
  // The load-bearing namespacing invariant: an un-namespaced mapping would let
  // a backend row named `anthropic` land in the MONITORED domain and get
  // auto-stopped + globally queued against a window it never touches.
  assert.equal(usageDomainOfBackend('ollama'), 'backend:ollama');
  assert.equal(usageDomainOfBackend('my-proxy'), 'backend:my-proxy');
  assert.equal(usageDomainOfBackend('anthropic'), 'backend:anthropic');
});

test('isMonitoredDomain: only the anthropic domain is monitored', () => {
  assert.equal(isMonitoredDomain('anthropic'), true);
  assert.equal(isMonitoredDomain('backend:anthropic'), false);
  assert.equal(isMonitoredDomain('backend:ollama'), false);
  assert.equal(isMonitoredDomain(undefined), false);
});
