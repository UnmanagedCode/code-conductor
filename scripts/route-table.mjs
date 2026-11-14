// The /api route table buildRoutes registers: one line per router layer in
// registration order (sub-routers indented), for the instances-present and
// -absent builds. `node scripts/route-table.mjs [present|absent]`.
import { buildRoutes } from '../src/routes.ts';

const STUB = new Proxy({}, { get: () => () => undefined });
export const VARIANTS = { present: { instances: STUB }, absent: {} };

const name = (f) => f.name || '<anon>';
const pathOf = (l) => (l.regexp.fast_slash ? '/' : l.regexp.source);
const keysOf = (l) => l.keys.map((k) => k.name).join(',');

// [{kind:'route'|'use'|'mount', depth, methods?, path?, handlers?, layer, children?}]
export function routeLayers(stack, depth = 0) {
  return stack.map((l) => l.route
    ? { kind: 'route', depth, layer: l, path: l.route.path,
        methods: [...new Set(l.route.stack.map((s) => s.method.toUpperCase()))],
        handlers: l.route.stack.map((s) => name(s.handle)) }
    : l.handle.stack
      ? { kind: 'mount', depth, layer: l, children: routeLayers(l.handle.stack, depth + 1) }
      : { kind: 'use', depth, layer: l, arity: l.handle.length, handlers: [name(l.handle)] });
}

export function formatRouteTable(layers, out = []) {
  for (const e of layers) {
    const pad = '  '.repeat(e.depth);
    if (e.kind === 'route') out.push(`${pad}ROUTE ${e.methods.join(',')} ${e.path} [${e.handlers.join(',')}]`);
    else if (e.kind === 'mount') { out.push(`${pad}MOUNT ${pathOf(e.layer)} keys=${keysOf(e.layer)} ${name(e.layer.handle)}`); formatRouteTable(e.children, out); }
    else out.push(`${pad}USE ${pathOf(e.layer)} keys=${keysOf(e.layer)} ${e.handlers[0]} arity=${e.arity}`);
  }
  return out;
}

export const tableFor = (variant) => formatRouteTable(routeLayers(buildRoutes(VARIANTS[variant]).stack)).join('\n');

if (import.meta.main) {
  const pick = process.argv[2] ? [process.argv[2]] : Object.keys(VARIANTS);
  for (const v of pick) {
    if (!process.argv[2]) console.log(`# instances: ${v}`);
    console.log(tableFor(v));
  }
}
