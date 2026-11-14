// Dependency-free helpers every layer imports. Imports nothing, so any module
// (server, shared, web) can depend on it without a cycle. A local copy of one
// elsewhere in src/ or shared/ fails tests/basics-guard.test.mjs.

// The string `code` a thrown value carries (Node system errors; handlers'
// Object.assign(new Error(…), { code })), or undefined.
export function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// Display text for any thrown value.
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The record view of a wire value: `{}` for anything else, so optional-field
// reads need no cast.
export function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

// One POSIX shell word for arbitrary text.
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
