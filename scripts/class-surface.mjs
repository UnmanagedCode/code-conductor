// The PRE/POST proof for a seam move: the export list and each exported class's
// prototype + static member names (accessor kind included, fields out of scope).
// `node scripts/class-surface.mjs <module>`; set the scratch store env first.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isClass = (v) => typeof v === 'function' && /^class\b/.test(Function.prototype.toString.call(v));

export async function classSurface(specifier) {
  const url = /^(data|file):/.test(specifier) ? specifier : pathToFileURL(path.resolve(specifier)).href;
  const ns = await import(url);
  const names = Object.keys(ns).sort();
  const out = names.map((n) => `EXPORT ${n} ${typeof ns[n]}`);
  for (const n of names) {
    const C = ns[n];
    if (!isClass(C)) continue;
    out.push(`CLASS ${n}`);
    for (const key of Object.getOwnPropertyNames(C.prototype)) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, key);
      const kind = d.get && d.set ? 'getset' : d.get ? 'get' : d.set ? 'set' : typeof d.value === 'function' ? 'method' : 'value';
      out.push(`${kind} ${key}`);
    }
    for (const key of Object.getOwnPropertyNames(C)) {
      if (key !== 'length' && key !== 'name' && key !== 'prototype') out.push(`static ${key}`);
    }
  }
  return out;
}

if (import.meta.main) {
  if (!process.argv[2]) { console.error('usage: node scripts/class-surface.mjs <module>'); process.exit(2); }
  process.stdout.write((await classSurface(process.argv[2])).join('\n') + '\n');
}
