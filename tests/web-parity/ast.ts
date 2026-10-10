// The one parser the parity check reads source with: Vite's oxc binding, which
// picks the language from the filename and never surfaces comments as nodes.
import { parseSync } from 'vite';

export type Node = { type: string; start: number; end: number; [key: string]: any };

/** The program of `file`'s `code`; a syntax error throws, naming the file. */
export function parseProgram(file: string, code: string): Node {
  const { program, errors } = parseSync(file, code);
  if (errors.length) throw new Error(`${file}: ${errors.map((e) => e.message).join('; ')}`);
  return program as unknown as Node;
}

/** The direct child nodes of `node`, in source order. */
export function childNodes(node: Node): Node[] {
  const out: Node[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v.type === 'string') out.push(v);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      out.push(value);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Calls `visit` on `node` and every node below it, depth first. */
export function eachNode(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const c of childNodes(node)) eachNode(c, visit);
}
