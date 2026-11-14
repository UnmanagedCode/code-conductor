// Lists the exports of the server sources (server.ts, src/, shared/) that no
// other git-tracked file's code references, values and types counted apart.
//
// A reference is the export's name as an identifier token in another tracked
// .ts/.tsx/.mts/.cts/.mjs/.js/.cjs file, with comments and template text blanked
// by tests/importCycles.mjs's blankNonCode (quoted strings stay, so string-keyed
// lookups count). Tests, web/, scripts/, harness/, claude-plugin/, bin/, docker/
// and migrations/ all count as callers. Mentions in docs, comments and other
// text files do not, and are listed in the textrefs column. A name shared with an
// unrelated identifier elsewhere is never flagged: the count errs low.
//
// own= is the name's token count in its own file's code: 1 means the declaration
// is its only use (dead), more means it is used locally (drop the `export`).
//
// CLI: `node scripts/unused-exports.mjs` prints one tab-separated row per
// flagged export, then a summary line. `--check` exits 1 when any value export
// is flagged.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../tests/importCycles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED = /^(?:server\.ts$|src\/|shared\/)/;
const CODE = /\.(?:ts|tsx|mts|cts|mjs|js|cjs)$/;
const TOKEN = /[A-Za-z_$][\w$]*/g;
const DECL = /^[ \t]*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(const\s+enum|const|let|var|function\*?|class|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const DESTRUCTURED = /^[ \t]*export\s+(?:const|let|var)\s*\{([^}]*)\}/gm;
const LIST = /^[ \t]*export\s+(type\s+)?\{([^}]*)\}/gm;

const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(f => f && fs.statSync(path.join(repoRoot, f), { throwIfNoEntry: false })?.isFile());

const codeRefs = new Map(); // token -> Set(file)
const textRefs = new Map();
const blanked = new Map();
const index = (map, text, file) => {
  for (const t of text.match(TOKEN) ?? []) {
    let set = map.get(t);
    if (!set) map.set(t, set = new Set());
    set.add(file);
  }
};
for (const f of files) {
  const raw = fs.readFileSync(path.join(repoRoot, f), 'utf8');
  if (CODE.test(f)) {
    const code = blankNonCode(raw);
    blanked.set(f, code);
    index(codeRefs, code, f);
    index(textRefs, raw, f);
  } else if (!raw.includes('\0')) {
    index(textRefs, raw, f);
  }
}

function exportsOf(code) {
  const out = [];
  for (const m of code.matchAll(DECL)) out.push({ name: m[2], kind: /^(?:interface|type)$/.test(m[1]) ? 'type' : 'value' });
  for (const m of code.matchAll(DESTRUCTURED)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (name) out.push({ name, kind: 'value' });
    }
  }
  for (const m of code.matchAll(LIST)) {
    for (const part of m[2].split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      const name = spec.split(/\s+as\s+/).pop().replace(/^type\s+/, '').trim();
      out.push({ name, kind: m[1] || /^type\s/.test(spec) ? 'type' : 'value' });
    }
  }
  return out;
}

const flagged = [];
for (const f of files.filter(f => SCANNED.test(f) && f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
  const code = blanked.get(f);
  for (const e of exportsOf(code)) {
    if ([...(codeRefs.get(e.name) ?? [])].some(x => x !== f)) continue;
    const own = (code.match(TOKEN) ?? []).filter(t => t === e.name).length;
    const text = [...(textRefs.get(e.name) ?? [])].filter(x => x !== f).sort();
    flagged.push({ file: f, ...e, own, text });
  }
}
flagged.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
for (const e of flagged) {
  console.log([e.file, e.name, e.kind, `own=${e.own}`, e.text.length ? `textrefs=${e.text.join(',')}` : '-'].join('\t'));
}
const values = flagged.filter(e => e.kind === 'value');
console.log(`TOTAL ${flagged.length}  value=${values.length} type=${flagged.length - values.length}  ownUse(own>1)=${flagged.filter(e => e.own > 1).length} unused(own<=1)=${flagged.filter(e => e.own <= 1).length}`);
if (process.argv.includes('--check') && values.length) process.exit(1);
