// Backend-scoped usage-window DOMAINS — the seam the overage stop/resume flow
// consults to decide whether an instance is subject to it at all.
//
// A "usage window" (rate-limit / overage window) is an account-provider concept:
// Anthropic accounts have the five-hour window the overage flow monitors; an
// Ollama backend hits a different endpoint with its own (not-yet-monitored)
// windows. Each backendKind maps to exactly one domain.
//
// The flow is domain-scoped rather than hardcoded to "skip if ollama": it acts on
// an instance only if the instance's agent tree touches a domain that CURRENTLY
// has an active monitor. Today that's just 'anthropic'. When an Ollama
// usage-window monitor ships, add 'ollama' to MONITORED_DOMAINS — no exemption
// logic elsewhere changes.

export const BACKEND_USAGE_DOMAIN = { claude: 'anthropic', ollama: 'ollama' };

// Domains with an active usage-window monitor driving the overage stop/resume
// flow. Add 'ollama' here the day an Ollama usage window is monitored.
const MONITORED_DOMAINS = new Set(['anthropic']);

export function usageDomainOfBackend(backendKind) {
  return BACKEND_USAGE_DOMAIN[backendKind === 'ollama' ? 'ollama' : 'claude'];
}

export function isMonitoredDomain(domain) {
  return MONITORED_DOMAINS.has(domain);
}
