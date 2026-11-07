// The language-neutral model the generated /mcp clients render from: each
// tool's parameters and result as a small type tree, plus every named object
// type those trees reference. Both renderers (python.ts, node.ts) read it, so
// the JSON-Schema semantics live here once.
//
// The accepted vocabulary is closed: the typing keywords outputSchemas.ts
// declares, plus the annotation keywords an input schema may carry. Anything
// else throws, naming the tool and the schema path — a schema the generator
// would mistype fails boot instead of shipping a wrong client.

export interface ClientToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export type TypeNode =
  | { kind: 'str' | 'int' | 'num' | 'bool' | 'null' | 'any' }
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'list'; item: TypeNode }
  | { kind: 'map'; value: TypeNode }
  | { kind: 'ref'; name: string }
  | { kind: 'union'; members: TypeNode[] };

export interface Field {
  key: string;
  type: TypeNode;
  optional: boolean;
  description?: string;
}

// In post-order: every declaration comes after the ones it references.
export type Declaration =
  | { kind: 'object'; name: string; fields: Field[] }
  | { kind: 'alias'; name: string; type: TypeNode };

export interface Param extends Field {
  hasDefault: boolean;
  default?: unknown;
}

export interface ToolModel {
  name: string;
  description: string;
  params: Param[];
  resultName: string;
}

export interface ClientModel {
  tools: ToolModel[];
  declarations: Declaration[];
}

// Tool names a client class already uses for its own members.
export const CLIENT_MEMBERS: readonly string[] = ['call', 'url'];

// The hard keywords of Python 3.11: a parameter named one is spelled with a
// trailing `_` in the Python client.
export const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const TYPING_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description']);
const ANNOTATION_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'default']);
const SCALARS: Record<string, TypeNode> = {
  string: { kind: 'str' }, integer: { kind: 'int' }, number: { kind: 'num' }, boolean: { kind: 'bool' }, null: { kind: 'null' },
};
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function pascal(s: string): string {
  return s.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// A Python parameter's spelling of the wire name `key`.
export function pyParamName(key: string): string {
  return PY_KEYWORDS.has(key) ? `${key}_` : key;
}

type Schema = Record<string, unknown>;

class Builder {
  readonly declarations: Declaration[] = [];
  readonly #names = new Set<string>();

  declare(d: Declaration): void {
    if (this.#names.has(d.name)) throw new Error(`mcp client: type name '${d.name}' is generated twice`);
    this.#names.add(d.name);
    this.declarations.push(d);
  }
}

function fail(where: string, what: string): never {
  throw new Error(`mcp client: ${what} at ${where}`);
}

function checkKeywords(s: Schema, where: string, input: boolean): void {
  for (const k of Object.keys(s)) {
    if (TYPING_KEYWORDS.has(k) || (input && ANNOTATION_KEYWORDS.has(k))) continue;
    fail(where, `unsupported schema keyword '${k}'`);
  }
}

function union(members: TypeNode[]): TypeNode {
  const flat = members.flatMap(m => m.kind === 'union' ? m.members : [m]);
  return flat.length === 1 ? flat[0] : { kind: 'union', members: flat };
}

function asSchema(v: unknown, where: string): Schema {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, 'a schema that is not an object');
  return v as Schema;
}

function fieldsOf(s: Schema, name: string, where: string, b: Builder, input: boolean): Field[] {
  const props = asSchema(s.properties, `${where}.properties`);
  const required = Array.isArray(s.required) ? s.required as string[] : [];
  return Object.entries(props).map(([key, raw]) => {
    const at = `${where}.properties.${key}`;
    if (!IDENTIFIER.test(key)) fail(at, `property name '${key}' is not an identifier`);
    const prop = asSchema(raw, at);
    const field: Field = { key, type: toType(prop, name + pascal(key), at, b, input), optional: !required.includes(key) };
    if (typeof prop.description === 'string') field.description = prop.description;
    return field;
  });
}

function toType(s: Schema, name: string, where: string, b: Builder, input: boolean): TypeNode {
  checkKeywords(s, where, input);
  if ('const' in s) return { kind: 'lit', value: s.const as string | number | boolean | null };
  if ('enum' in s) {
    if (!Array.isArray(s.enum)) fail(where, "an 'enum' that is not an array");
    return union(s.enum.map(v => ({ kind: 'lit', value: v as string | number | boolean | null })));
  }
  if ('anyOf' in s) {
    if ('properties' in s) fail(where, "'anyOf' together with 'properties'");
    if (!Array.isArray(s.anyOf)) fail(where, "an 'anyOf' that is not an array");
    return union(s.anyOf.map((v, i) => toType(asSchema(v, `${where}.anyOf[${i}]`), `${name}Variant${i + 1}`, `${where}.anyOf[${i}]`, b, input)));
  }
  if (Array.isArray(s.type)) {
    return union(s.type.map(t => toType({ ...s, type: t }, name, where, b, input)));
  }
  if (s.type === 'object') {
    if ('properties' in s) {
      b.declare({ kind: 'object', name, fields: fieldsOf(s, name, where, b, input) });
      return { kind: 'ref', name };
    }
    const ap = s.additionalProperties;
    if (ap && typeof ap === 'object') {
      return { kind: 'map', value: toType(asSchema(ap, `${where}.additionalProperties`), `${name}Value`, `${where}.additionalProperties`, b, input) };
    }
    return { kind: 'map', value: { kind: 'any' } };
  }
  if (s.type === 'array') {
    return { kind: 'list', item: s.items === undefined ? { kind: 'any' } : toType(asSchema(s.items, `${where}.items`), `${name}Item`, `${where}.items`, b, input) };
  }
  if (typeof s.type === 'string') {
    const scalar = SCALARS[s.type];
    if (!scalar) fail(where, `unsupported type '${s.type}'`);
    return scalar;
  }
  if ('type' in s) fail(where, "a 'type' that is neither a string nor an array");
  return { kind: 'any' };
}

function paramsOf(t: ClientToolSpec, b: Builder): Param[] {
  const where = `${t.name}.inputSchema`;
  const s = asSchema(t.inputSchema, where);
  checkKeywords(s, where, true);
  if (s.type !== 'object') fail(where, "an input schema whose 'type' is not 'object'");
  if (!('properties' in s)) return [];
  return fieldsOf(s, `${pascal(t.name)}Args`, where, b, true).map(f => {
    if (f.key === 'self') fail(`${where}.properties.self`, "a parameter named 'self'");
    const prop = (s.properties as Record<string, Schema>)[f.key];
    const p: Param = { ...f, hasDefault: 'default' in prop };
    if (p.hasDefault) p.default = prop.default;
    return p;
  });
}

export function buildClientModel(tools: ClientToolSpec[]): ClientModel {
  const b = new Builder();
  const out: ToolModel[] = [];
  for (const t of tools) {
    if (CLIENT_MEMBERS.includes(t.name)) fail(t.name, `a tool named '${t.name}', which is a client member`);
    if (!IDENTIFIER.test(t.name)) fail(t.name, `tool name '${t.name}' is not an identifier`);
    const params = paramsOf(t, b);
    const resultName = `${pascal(t.name)}Result`;
    const result = toType(asSchema(t.outputSchema, `${t.name}.outputSchema`), resultName, `${t.name}.outputSchema`, b, false);
    if (!(result.kind === 'ref' && result.name === resultName)) b.declare({ kind: 'alias', name: resultName, type: result });
    out.push({ name: t.name, description: t.description, params, resultName });
  }
  return { tools: out, declarations: b.declarations };
}
