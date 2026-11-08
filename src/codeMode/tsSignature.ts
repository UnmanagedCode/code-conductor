// A tool as a TypeScript declaration: what `describe_tools` returns at
// `detail: 'full'`. The mapping from the type model (typeModel.ts) is
// docs/code-mode.md → TypeScript signatures.

import { buildToolModel, type Declaration, type Field, type TypeNode } from './typeModel.ts';

export interface SignatureInput {
  // The function's name in the declaration (the bare tool name, `-` as `_`).
  fnName: string;
  // Prefix of every named type, so signatures of different tools never clash.
  typeBase?: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function render(t: TypeNode): string {
  switch (t.kind) {
    case 'str': return 'string';
    case 'int': case 'num': return 'number';
    case 'bool': return 'boolean';
    case 'null': return 'null';
    case 'any': return 'unknown';
    case 'lit': return JSON.stringify(t.value);
    case 'list': return t.item.kind === 'union' ? `(${render(t.item)})[]` : `${render(t.item)}[]`;
    case 'map': return `Record<string, ${render(t.value)}>`;
    case 'union': return t.members.map(render).join(' | ');
    case 'ref': return t.name;
  }
}

function docComment(text: string, indent: string): string {
  const lines = text.replaceAll('*/', '*\\/').split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map(l => `${indent} * ${l}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

function fieldLine(f: Field): string {
  const doc = [f.description, f.hasDefault ? `@default ${JSON.stringify(f.default)}` : undefined]
    .filter(Boolean).join('\n');
  const key = IDENT.test(f.key) ? f.key : JSON.stringify(f.key);
  return (doc ? docComment(doc, '  ') : '') + `  ${key}${f.optional ? '?' : ''}: ${render(f.type)};\n`;
}

function declaration(d: Declaration): string {
  if (d.kind === 'alias') return `type ${d.name} = ${render(d.type)};\n`;
  return `interface ${d.name} {\n${d.fields.map(fieldLine).join('')}}\n`;
}

// Throws on a schema outside the model's vocabulary; the caller degrades.
export function renderSignature(s: SignatureInput): string {
  const model = buildToolModel({
    name: s.typeBase ?? s.fnName,
    description: s.description,
    inputSchema: s.inputSchema,
    outputSchema: s.outputSchema,
  });
  const param = model.args
    ? `args${model.args.optional ? '?' : ''}: ${model.args.name}`
    : 'args?: Record<string, unknown>';
  const parts = [
    docComment(s.description, ''),
    `declare function ${s.fnName}(${param}): Promise<${render(model.result)}>;\n`,
    ...model.declarations.map(declaration),
  ];
  return parts.join('\n').trimEnd();
}

