// Secret strings the harness must never print. Every harness error and every
// server-log tail it surfaces goes through redact(); credentials.ts registers
// the live access token here the moment it reads it.

const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return out;
}
