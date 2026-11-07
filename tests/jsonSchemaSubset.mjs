// A strict validator for the JSON Schema subset src/mcp/outputSchemas.ts is
// written in: type (incl. unions), properties, required, additionalProperties
// (boolean | schema), items, enum, const, anyOf, description.
//
// STRICT in two ways, so a schema can never lean on a keyword this validator
// would silently ignore:
//   - any other keyword is a schema error;
//   - a schema whose type admits 'object' must state additionalProperties.
// No dependency (the node suite adds none).

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

// Throws on the first schema-shape error; returns nothing when the schema is
// within the subset.
export function checkSchema(schema, at = '#') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${at}: a schema must be an object`);
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) throw new Error(`${at}: keyword '${k}' is outside the validated subset`);
  }
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  for (const t of types) if (!TYPES.has(t)) throw new Error(`${at}: unknown type '${t}'`);
  if (types.includes('object') && !('additionalProperties' in schema)) {
    throw new Error(`${at}: an object schema must state additionalProperties`);
  }
  if (schema.properties !== undefined) {
    for (const [k, s] of Object.entries(schema.properties)) checkSchema(s, `${at}/properties/${k}`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new Error(`${at}: required must be an array`);
    for (const k of schema.required) {
      if (!schema.properties || !(k in schema.properties)) throw new Error(`${at}: required '${k}' is not a property`);
    }
  }
  const ap = schema.additionalProperties;
  if (ap !== undefined && typeof ap !== 'boolean') checkSchema(ap, `${at}/additionalProperties`);
  if (schema.items !== undefined) checkSchema(schema.items, `${at}/items`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`${at}: enum must be an array`);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new Error(`${at}: anyOf must be a non-empty array`);
    schema.anyOf.forEach((s, i) => checkSchema(s, `${at}/anyOf/${i}`));
  }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(t, v) {
  const actual = typeOf(v);
  return t === actual || (t === 'number' && actual === 'integer');
}

// The validation errors for `value` against `schema` (empty when valid).
export function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some(t => typeMatches(t, value))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${at}: missing required '${k}'`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errors.push(...validate(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property '${k}'`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
      }
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map(s => validate(s, value, at));
    if (!branches.some(b => b.length === 0)) {
      errors.push(`${at}: matches no anyOf branch — ${branches.map((b, i) => `#${i}: ${b.slice(0, 3).join('; ')}`).join(' | ')}`);
    }
  }
  return errors;
}
