// The static full-title resolver: a test file's titles as its runner names
// them (describe titles + test title, joined by ' > '), read from the AST, so
// the ledger check runs no suite. Its grammar is in docs/frontend-testing.md →
// Parity ledger.
import { UI_NAMES } from '../../web/e2e/parity/uis.ts';
import { childNodes, eachNode, parseProgram, type Node } from './ast.ts';

const BASE = new Set(['test', 'it', 'describe', 'suite']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'fixme', 'concurrent', 'serial', 'parallel', 'fails', 'sequential', 'describe']);
const TABLES = new Set(['each', 'for']);
const FUNCTION_ARG = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'Identifier']);

export type ParityLink = { rowId: string | null; title: string | null };

/** Whether `callee` names a base test function: modifiers and `.each(…)`/`.for(…)` peeled. */
function isBaseCallee(callee: Node): boolean {
  if (callee.type === 'Identifier') return BASE.has(callee.name);
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const prop = callee.property.name;
    if (MODIFIERS.has(prop)) return isBaseCallee(callee.object);
    return BASE.has(prop);
  }
  if ((callee.type === 'CallExpression' || callee.type === 'TaggedTemplateExpression')) {
    const inner = callee.type === 'CallExpression' ? callee.callee : callee.tag;
    return inner.type === 'MemberExpression' && !inner.computed && inner.property.type === 'Identifier'
      && TABLES.has(inner.property.name) && isBaseCallee(inner.object);
  }
  return false;
}

/** A literal title argument's text: a string's value, a template's raw source; otherwise null. */
function titleText(arg: Node | undefined, code: string): string | null {
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral') return code.slice(arg.start + 1, arg.end - 1);
  return null;
}

/** The function a top-level declaration binds, with its name. */
function declaredFunction(stmt: Node): { name: string; fn: Node } | null {
  if (stmt.type === 'FunctionDeclaration' && stmt.id) return { name: stmt.id.name, fn: stmt };
  if (stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1) {
    const d = stmt.declarations[0];
    if (d.id.type === 'Identifier' && (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression')) {
      return { name: d.id.name, fn: d.init };
    }
  }
  return null;
}

/**
 * The file's one-hop wrappers: top-level functions whose body calls a base test
 * function with the wrapper's own first parameter as the title.
 */
function wrapperNames(program: Node): Set<string> {
  const names = new Set<string>();
  for (const stmt of program.body as Node[]) {
    const decl = declaredFunction(stmt);
    const first = decl?.fn.params[0];
    if (!decl || first?.type !== 'Identifier') continue;
    let wraps = false;
    eachNode(decl.fn.body, (n) => {
      if (n.type === 'CallExpression' && isBaseCallee(n.callee)
        && n.arguments[0]?.type === 'Identifier' && n.arguments[0].name === first.name) wraps = true;
    });
    if (wraps) names.add(decl.name);
  }
  return names;
}

function resolve(file: string, code: string): { titles: string[]; links: ParityLink[] } {
  const program = parseProgram(file, code);
  const wrappers = wrapperNames(program);
  const titles: string[] = [];
  const links: ParityLink[] = [];
  const visit = (node: Node, parents: string[]): void => {
    if (node.type === 'CallExpression') {
      const args = node.arguments as Node[];
      if (node.callee.type === 'Identifier' && node.callee.name === 'parity') {
        const rowId = args[0]?.type === 'Literal' && typeof args[0].value === 'string' ? args[0].value : null;
        const title = titleText(args[1], code);
        links.push({ rowId, title });
        if (title !== null) {
          for (const ui of UI_NAMES) titles.push([...parents, title, ui].join(' > '));
          for (const a of args.slice(2)) visit(a, [...parents, title]);
          return;
        }
      } else {
        const named = isBaseCallee(node.callee) || (node.callee.type === 'Identifier' && wrappers.has(node.callee.name));
        const title = named ? titleText(args[0], code) : null;
        if (title !== null && args.slice(1).some((a) => FUNCTION_ARG.has(a.type))) {
          const path = [...parents, title];
          titles.push(path.join(' > '));
          for (const a of args.slice(1)) visit(a, path);
          return;
        }
      }
    }
    for (const c of childNodes(node)) visit(c, parents);
  };
  visit(program, []);
  return { titles, links };
}

/** Every full title `file` declares, in source order. */
export function testTitles(file: string, code: string): string[] {
  return resolve(file, code).titles;
}

/** Every `parity(rowId, title, fn)` call in `file`; a non-literal argument reads null. */
export function parityLinks(file: string, code: string): ParityLink[] {
  return resolve(file, code).links;
}
