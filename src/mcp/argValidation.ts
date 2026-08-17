// MCP tools/call argument validation — and the keyword vocabulary it enforces.
//
// Extracted from mcp/server.ts so the vocabulary lives WITH its enforcer, and so
// the one module that has to agree with it can import the list rather than
// re-encoding it by hand:
//   - `checkConstraints` below ENFORCES these keywords at tools/call.
//   - `checkSchemaSubset` (plugins/manifest.ts) REJECTS a plugin tool schema
//     using anything outside them, at manifest load.
//
// Teaching the enforcer a keyword without widening the allow-list makes a legal
// schema get rejected; widening the allow-list without teaching the enforcer
// ships a constraint that is silently never checked — the worse direction, since
// the plugin author is told it works. Deriving ALLOWED_PROP_KEYS from
// VALIDATED_CONSTRAINT_KEYS makes either half impossible to change alone;
// tests/schema-keyword-sync.test.mjs proves each listed keyword really is
// enforced.
//
// No imports from ../plugins: the plugin host is wired into the MCP server, so
// that edge would close a cycle.

// Keywords `checkConstraints` branches on.
export const VALIDATED_CONSTRAINT_KEYS = [
  'type',       // typeMatches — string/number/integer/boolean/object/array/null
  'enum',       // membership
  'minLength',  // strings
  'maxLength',  // strings
  'pattern',    // strings, as a RegExp
  'minimum',    // numbers
  'maximum',    // numbers
  'items',      // arrays, element `type` only
] as const;

// Accepted on a property but carrying no runtime constraint: purely
// descriptive, so there is nothing for the enforcer to check.
export const DESCRIPTIVE_PROP_KEYS = ['description', 'default'] as const;

// The full per-property allow-list `checkSchemaSubset` enforces.
export const ALLOWED_PROP_KEYS: ReadonlySet<string> =
  new Set<string>([...VALIDATED_CONSTRAINT_KEYS, ...DESCRIPTIVE_PROP_KEYS]);

function isJsonRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> {
  return isJsonRecord(v) ? v : {};
}

// Shallow JSON-Schema validation. Covers the shapes we use: object with
// named properties, scalar types, required keys, plus the constraint keywords
// our schemas declare (enum, pattern, min/maxLength, minimum/maximum, array
// items.type). Returns null on success or a string describing the first
// violation. No $ref / oneOf / anyOf — the registry doesn't use those.
// Unknown properties are rejected (clean MCP contract — no silent drops).
export function validateArgs(schema: unknown, args: unknown, toolName: unknown): string | null {
  if (!isJsonRecord(schema) || schema.type !== 'object') return null;
  const a = args ?? {};
  if (!isJsonRecord(a)) return 'arguments must be an object';
  const req = Array.isArray(schema.required) ? schema.required : [];
  for (const k of req) {
    if (typeof k !== 'string' || !(k in a)) return `missing required argument: ${k}`;
  }
  const props = asRecord(schema.properties);
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) {
      const allowed = Object.keys(props).join(', ') || '(none)';
      return `unexpected argument '${k}' — not a recognized parameter for ${toolName ?? 'this tool'}. Allowed: ${allowed}`;
    }
    const viol = checkConstraints(k, v, asRecord(p));
    if (viol) return viol;
  }
  return null;
}

// Validate a single value against its property schema. Returns a violation
// string or null. Skips constraint checks when the type doesn't match the
// constraint's domain (the type error already fired, or the keyword is N/A).
//
// The keywords branched on below are enumerated in VALIDATED_CONSTRAINT_KEYS
// (./schemaKeywords.ts), which plugins/manifest.ts derives its allow-list from.
// Teaching this function a new keyword means adding it there too, or plugin
// authors get told a constraint works when nothing checks it.
function checkConstraints(k: string, v: unknown, p: Record<string, unknown>): string | null {
  const t = p.type;
  if (t && !typeMatches(t, v)) {
    return `argument '${k}' must be ${Array.isArray(t) ? t.join(' | ') : t}`;
  }
  const en = p.enum;
  if (typeof en === 'string' && en) {
    if (!en.includes(String(v))) return `argument '${k}' must be one of ${JSON.stringify(en)}`;
  } else if (Array.isArray(en) && !en.includes(v)) {
    return `argument '${k}' must be one of ${JSON.stringify(en)}`;
  }
  if (typeof v === 'string') {
    if (typeof p.minLength === 'number' && v.length < p.minLength) {
      return `argument '${k}' must be at least ${p.minLength} character(s)`;
    }
    if (typeof p.maxLength === 'number' && v.length > p.maxLength) {
      return `argument '${k}' must be at most ${p.maxLength} character(s)`;
    }
    if (typeof p.pattern === 'string' && !new RegExp(p.pattern).test(v)) {
      return `argument '${k}' must match ${p.pattern}`;
    }
  }
  if (typeof v === 'number') {
    if (typeof p.minimum === 'number' && v < p.minimum) {
      return `argument '${k}' must be >= ${p.minimum}`;
    }
    if (typeof p.maximum === 'number' && v > p.maximum) {
      return `argument '${k}' must be <= ${p.maximum}`;
    }
  }
  if (Array.isArray(v) && isJsonRecord(p.items) && p.items.type) {
    for (let i = 0; i < v.length; i++) {
      if (!typeMatches(p.items.type, v[i])) {
        return `argument '${k}[${i}]' must be ${p.items.type}`;
      }
    }
  }
  return null;
}

function typeMatches(t: unknown, v: unknown): boolean {
  const ts: unknown[] = Array.isArray(t) ? t : [t];
  for (const one of ts) {
    if (one === 'string' && typeof v === 'string') return true;
    if (one === 'number' && typeof v === 'number') return true;
    if (one === 'integer' && Number.isInteger(v)) return true;
    if (one === 'boolean' && typeof v === 'boolean') return true;
    if (one === 'object' && v && typeof v === 'object' && !Array.isArray(v)) return true;
    if (one === 'array' && Array.isArray(v)) return true;
    if (one === 'null' && v === null) return true;
  }
  return false;
}
