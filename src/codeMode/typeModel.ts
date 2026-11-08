// The language-neutral model a tool's TypeScript signature renders from
// (tsSignature.ts): its parameters and result as a small type tree, plus every
// named object type those trees reference. Built per tool, so type names
// cannot collide across tools.
//
// The accepted vocabulary is closed: the typing keywords outputSchemas.ts
// declares, plus the annotation keywords an input schema may carry. Anything
// else throws, naming the tool and the schema path; describe_tools catches it
// per tool and degrades that one entry.

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  // Absent means the tool declares no result shape: the result type is `unknown`.
  outputSchema?: unknown;
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
  hasDefault?: boolean;
  default?: unknown;
}

// In post-order: every declaration comes after the ones it references.
export type Declaration =
  | { kind: 'object'; name: string; fields: Field[] }
  | { kind: 'alias'; name: string; type: TypeNode };

export interface ToolModel {
  // The named type of the arguments object, or null when the tool takes no
  // declared properties.
  args: { name: string; optional: boolean } | null;
  result: TypeNode;
  declarations: Declaration[];
}

const TYPING_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description']);
const ANNOTATION_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'default']);
const SCALARS: Record<string, TypeNode> = {
  string: { kind: 'str' }, integer: { kind: 'int' }, number: { kind: 'num' }, boolean: { kind: 'bool' }, null: { kind: 'null' },
};

export function pascal(s: string): string {
  return s.split(/[_-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

type Schema = Record<string, unknown>;

class Builder {
  readonly declarations: Declaration[] = [];
  readonly #names = new Set<string>();

  declare(d: Declaration): void {
    if (this.#names.has(d.name)) throw new Error(`code mode: type name '${d.name}' is generated twice`);
    this.#names.add(d.name);
    this.declarations.push(d);
  }
}

function fail(where: string, what: string): never {
  throw new Error(`code mode: ${what} at ${where}`);
}

function checkKeywords(s: Schema, where: string, input: boolean): void {
  for (const k of Object.keys(s)) {
    if (TYPING_KEYWORDS.has(k) || (input && ANNOTATION_KEYWORDS.has(k))) continue;
    fail(where, `unsupported schema keyword '${k}'`);
  }
}

function literal(v: unknown): TypeNode {
  return { kind: 'lit', value: v as string | number | boolean | null };
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
    const prop = asSchema(raw, at);
    const field: Field = { key, type: toType(prop, name + pascal(key), at, b, input), optional: !required.includes(key) };
    if (typeof prop.description === 'string') field.description = prop.description;
    if ('default' in prop) { field.hasDefault = true; field.default = prop.default; }
    return field;
  });
}

function toType(s: Schema, name: string, where: string, b: Builder, input: boolean): TypeNode {
  checkKeywords(s, where, input);
  if ('const' in s) return literal(s.const);
  if ('enum' in s) {
    if (!Array.isArray(s.enum)) fail(where, "an 'enum' that is not an array");
    return union(s.enum.map(v => literal(v)));
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

export function buildToolModel(t: ToolSpec): ToolModel {
  const b = new Builder();
  const base = pascal(t.name);
  const where = `${t.name}.inputSchema`;
  const input = asSchema(t.inputSchema, where);
  checkKeywords(input, where, true);
  if (input.type !== 'object') fail(where, "an input schema whose 'type' is not 'object'");
  let args: ToolModel['args'] = null;
  if ('properties' in input) {
    const name = `${base}Args`;
    const fields = fieldsOf(input, name, where, b, true);
    b.declare({ kind: 'object', name, fields });
    args = { name, optional: fields.every(f => f.optional) };
  }
  let result: TypeNode = { kind: 'any' };
  if (t.outputSchema !== undefined) {
    const resultName = `${base}Result`;
    const at = `${t.name}.outputSchema`;
    result = toType(asSchema(t.outputSchema, at), resultName, at, b, false);
    if (!(result.kind === 'ref' && result.name === resultName)) {
      b.declare({ kind: 'alias', name: resultName, type: result });
      result = { kind: 'ref', name: resultName };
    }
  }
  return { args, result, declarations: b.declarations };
}
