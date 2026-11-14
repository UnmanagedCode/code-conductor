// The registry of every environment variable the server's code reads or sets,
// and the default listen port. Dependency-free: bin/windows-launch.mjs imports it.
export const DEFAULT_PORT = 8787;

// knob: a cc-owned setting or seam that an operator or test sets.
// internal: cc sets it for its own child or successor and reads it back.
// platform: a host OS/runtime var cc reads but does not own.
// exported: cc sets it for a child, and production never reads it.
// tooling: read only by tests/, scripts/, migrations/ or web/vite.config.ts.
type EnvKind = 'knob' | 'internal' | 'platform' | 'exported' | 'tooling';
interface EnvVar { kind: EnvKind; default: string | null; purpose: string }

export const ENV_VARS: Readonly<Record<string, EnvVar>> = {};
