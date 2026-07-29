// Backend-scoped usage-window DOMAINS — the seam the overage stop/resume flow
// consults to decide whether an instance is subject to it at all.
//
// A "usage window" (rate-limit / overage window) is an account-provider concept:
// Anthropic accounts have the five-hour window the overage flow monitors; every
// other backend hits a different endpoint with its own (not-yet-monitored)
// windows. Each backend maps to exactly one domain: the identity `claude` backend
// to 'anthropic', any other backend to `backend:<its id>`.
//
// The `backend:` prefix is load-bearing, not cosmetic: backend ids are
// user-chosen, so an un-namespaced mapping would let a row literally named
// `anthropic` land in the MONITORED domain and get auto-stopped + globally queued
// against a window it never touches. Namespacing makes that collision impossible by
// construction, so no id needs reserving.
//
// The flow is domain-scoped rather than hardcoded per provider: it acts on an
// instance only if the instance's agent tree touches a domain that CURRENTLY has
// an active monitor. Today that's just 'anthropic'. When some other backend's
// usage window becomes monitorable, add its domain to MONITORED_DOMAINS — no
// exemption logic elsewhere changes.

import { CLAUDE_BACKEND_ID } from './modelVersions.js';

export const ANTHROPIC_DOMAIN = 'anthropic';

// Domains with an active usage-window monitor driving the overage stop/resume
// flow.
const MONITORED_DOMAINS = new Set([ANTHROPIC_DOMAIN]);

export function usageDomainOfBackend(backend) {
  if (typeof backend !== 'string' || !backend || backend === CLAUDE_BACKEND_ID) return ANTHROPIC_DOMAIN;
  return `backend:${backend}`;
}

export function isMonitoredDomain(domain) {
  return MONITORED_DOMAINS.has(domain);
}
