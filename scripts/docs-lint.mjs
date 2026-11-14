#!/usr/bin/env node
// Docs lint: backticked paths and code names must resolve in the repo, doc links and their
// anchors must resolve, and every doc stays inside the line and byte caps a single Read call
// can load. Rules: docs/architecture.md → Conventions.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Names the docs use correctly that no file of this repo spells. One owner per group; an entry
// that starts to resolve, or that no checked doc uses, is itself a finding.
export const NOT_IN_REPO = {
  // Linux kernel / libc names
  linux: ['CAP_DAC_READ_SEARCH', 'SO_PEERCRED'],
  // Browser DOM APIs
  dom: ['EventSource', 'insertAdjacentHTML', 'hasFocus', 'audioWorklet', 'addModule'],
  // React
  react: ['IS_REACT_ACT_ENVIRONMENT'],
  // react-markdown
  reactMarkdown: ['skipHtml'],
  // Vitest
  vitest: ['hookTimeout'],
  // Vite
  vite: ['changeOrigin'],
  // Playwright
  playwright: ['connectOverCDP', 'artifactsDir'],
  // Claude CLI
  claudeCli: ['TaskGet', 'TaskList', 'CLAUDE_CODE_ENABLE_TASKS', 'supportedDialogKinds'],
  // Plugin pages (docs/plugin-ui.md)
  pluginPages: ['useTheme', 'ASSET_RE'],
  // Windows installer (a separate project)
  windowsInstaller: ['detectGit'],
  // Named in the docs as absent from this repo
  namedAbsent: ['prunedFrom', 'turnEndSeqs', 'SESSION_FILE_CAP_BYTES', 'src/README.md', 'src/systems/fileBridge.ts'],
};

export const LINE_CAP = 2000;
export const DEFAULT_BYTE_CAP = 100000;
// Docs over the default cap, each held at its current size rounded up to the next 10,000 bytes.
export const BYTE_CAPS = {
  'docs/features.md': 410000,
  'docs/protocol.md': 400000,
  'docs/plugins.md': 130000,
};

const PATH_RE = /^(?:server\.ts|(?:src|shared|web|tests|scripts|migrations|conventions|claude-plugin|bin|harness|docker|playbooks|docs)\/[\w.\/@-]*)$/;
const BARE_FILE_RE = /^[^/]+\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|jsonl|md|sh|py|c|h|css|html|svg|yml|yaml|txt|log|lock|bak|onnx)$/;
const CHAIN_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CODE_LIKE = [/^_?[a-z][a-z0-9]*[A-Z]/, /^[A-Z][a-z0-9]+[A-Z]/, /^_[A-Za-z]/, /^[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]$/];
const SPAN_RE = /(?<!`)`([^`\n]+)`(?!`)/g;
const SELF = new Set(['scripts/docs-lint.mjs', 'tests/docs-lint.test.mjs']);

const git = (root, args, input) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, input });

const isCodeLike = (seg) => CODE_LIKE.some((re) => re.test(seg));

/** Lines with a fence flag: `{ text, line, fenced }` (fence marker lines count as fenced). */
function scanLines(text) {
  const out = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    const marker = /^\s*(?:```|~~~)/.test(raw);
    if (marker) {
      fenced = !fenced;
      out.push({ text: raw, line: i + 1, fenced: true });
    } else out.push({ text: raw, line: i + 1, fenced });
  });
  return out;
}

const stripCode = (s) => s.replace(SPAN_RE, '');

function slugOf(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Heading slugs (with GitHub duplicate suffixes) and `<a name|id>` anchors of a doc. */
function anchorsOf(text) {
  const slugs = [];
  const set = new Set();
  const seen = new Map();
  for (const l of scanLines(text)) {
    if (l.fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l.text);
    if (!m) continue;
    const base = slugOf(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const slug = n ? `${base}-${n}` : base;
    slugs.push({ slug, heading: m[1], line: l.line });
    set.add(slug);
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
  return { set, slugs };
}

export function lintDocs(root, { allow = NOT_IN_REPO } = {}) {
  const res = { dead: [], longLines: [], overCap: [], staleAllow: [], unindexed: [] };
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter((f) => f && fs.existsSync(path.join(root, f)));
  const fileSet = new Set(listed);
  const dirSet = new Set();
  for (const f of listed) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirSet.add(d);

  const docs = listed.filter((f) => f.startsWith('docs/') && f.endsWith('.md'));
  const checked = [...docs, ...['README.md', 'CLAUDE.md'].filter((f) => fileSet.has(f))];
  const text = new Map(checked.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));

  // Corpus tokens.
  const tokens = new Set();
  for (const f of listed) {
    if (f.startsWith('docs/') || f.endsWith('.md') || SELF.has(f)) continue;
    const buf = fs.readFileSync(path.join(root, f));
    if (buf.includes(0)) continue;
    for (const m of buf.toString('utf8').matchAll(/[A-Za-z_$][\w$]*/g)) tokens.add(m[0]);
  }

  const allowEntries = new Set(Object.values(allow).flat());
  const allowUsed = new Set();

  // Path resolution, with git check-ignore for build outputs.
  const pathCache = new Map();
  const resolvesNow = (p0) => {
    const p = p0.replace(/\/$/, '');
    return fileSet.has(p) || dirSet.has(p) || listed.some((f) => f.startsWith(`${p}-`));
  };
  const pending = new Set();
  const dead = []; // {file, line, ref, kind}

  for (const f of checked) {
    const body = text.get(f);
    for (const l of scanLines(body)) {
      if (l.fenced) continue;
      for (const m of l.text.matchAll(SPAN_RE)) {
        const span = m[1].trim();
        if (PATH_RE.test(span)) {
          if (span.split('/').includes('..')) continue;
          if (allowEntries.has(span)) { allowUsed.add(span); continue; }
          if (!pathCache.has(span)) {
            const ok = resolvesNow(span);
            pathCache.set(span, ok);
            if (!ok) pending.add(span);
          }
          dead.push({ file: f, line: l.line, ref: span, kind: 'path' });
          continue;
        }
        if (BARE_FILE_RE.test(span)) continue;
        const bare = span.replace(/\([^()]*\)$/, '');
        if (!CHAIN_RE.test(bare)) continue;
        for (const seg of bare.split('.')) {
          if (!isCodeLike(seg)) continue;
          if (allowEntries.has(seg)) { allowUsed.add(seg); continue; }
          if (!tokens.has(seg)) dead.push({ file: f, line: l.line, ref: seg, kind: 'symbol' });
        }
      }
    }
  }
  // Settle path candidates: drop the ones that resolve or are ignored.
  const unresolved = [...pending];
  const ignored = new Set();
  if (unresolved.length) {
    const cand = unresolved.flatMap((p) => [p.replace(/\/$/, ''), `${p.replace(/\/$/, '')}/`]);
    let out = '';
    try {
      out = git(root, ['check-ignore', '--no-index', '--stdin'], cand.join('\n'));
    } catch (e) {
      out = e.stdout ?? ''; // exit 1 = nothing ignored
    }
    for (const line of out.split('\n')) if (line) ignored.add(line.replace(/\/$/, ''));
  }
  for (const d of dead) {
    if (d.kind === 'path' && (pathCache.get(d.ref) || ignored.has(d.ref.replace(/\/$/, '')))) continue;
    res.dead.push({ file: d.file, line: d.line, text: d.ref, why: d.kind === 'path' ? 'path does not resolve' : 'name appears in no non-doc file' });
  }

  // Links.
  const anchorCache = new Map();
  const anchors = (f) => {
    if (!anchorCache.has(f)) anchorCache.set(f, anchorsOf(text.has(f) ? text.get(f) : fs.readFileSync(path.join(root, f), 'utf8')));
    return anchorCache.get(f);
  };
  for (const f of checked) {
    for (const l of scanLines(text.get(f))) {
      if (l.fenced) continue;
      for (const m of stripCode(l.text).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [file, frag] = target.split('#');
        let tf = f;
        if (file) {
          if (!file.endsWith('.md')) continue;
          tf = path.posix.normalize(path.posix.join(path.posix.dirname(f), file));
          if (!fileSet.has(tf)) {
            res.dead.push({ file: f, line: l.line, text: target, why: 'link target file does not exist' });
            continue;
          }
        }
        if (frag && !anchors(tf).set.has(frag)) {
          res.dead.push({ file: f, line: l.line, text: target, why: 'link anchor does not exist' });
        }
      }
    }
  }

  // Caps.
  for (const f of docs) {
    const body = text.get(f);
    const bytes = Buffer.byteLength(body);
    const cap = BYTE_CAPS[f] ?? DEFAULT_BYTE_CAP;
    if (bytes > cap) res.overCap.push({ file: f, text: String(bytes), why: `${bytes} bytes exceeds the ${cap}-byte cap` });
    body.split('\n').forEach((line, i) => {
      if (line.length <= LINE_CAP) return;
      if (f in BYTE_CAPS && /^\s*\|/.test(line)) return;
      res.longLines.push({ file: f, line: i + 1, text: line.slice(0, 60), why: `${line.length} chars exceeds the ${LINE_CAP}-char line cap` });
    });
  }

  // Components index sync.
  if (fileSet.has('docs/components.md') || docs.some((d) => d.startsWith('docs/components/'))) {
    const index = text.get('docs/components.md') ?? '';
    const linked = new Set([...index.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]));
    for (const f of docs.filter((d) => d.startsWith('docs/components/'))) {
      const rel = `components/${path.posix.basename(f)}`;
      for (const h of anchorsOf(text.get(f)).slugs) {
        const raw = text.get(f).split('\n')[h.line - 1];
        if (!raw.startsWith('## ')) continue;
        if (!linked.has(`${rel}#${h.slug}`)) res.unindexed.push({ file: f, line: h.line, text: h.heading, why: 'no link in docs/components.md' });
      }
    }
  }

  // Allowlist hygiene.
  for (const e of allowEntries) {
    const isPath = e.includes('/');
    const resolves = isPath ? resolvesNow(e) : tokens.has(e);
    if (resolves) res.staleAllow.push({ file: 'scripts/docs-lint.mjs', text: e, why: 'resolves in the repo; remove it from NOT_IN_REPO' });
    else if (!allowUsed.has(e)) res.staleAllow.push({ file: 'scripts/docs-lint.mjs', text: e, why: 'no checked doc uses it; remove it from NOT_IN_REPO' });
  }
  return res;
}

export function formatFindings(res) {
  const rows = [];
  for (const [k, list] of Object.entries(res)) for (const r of list) rows.push(`${k}\t${r.file}${r.line ? `:${r.line}` : ''}\t${r.text}\t${r.why}`);
  return rows;
}

export function summary(res) {
  return `docs-lint: dead=${res.dead.length} long-lines=${res.longLines.length} over-cap=${res.overCap.length} stale-allow=${res.staleAllow.length} unindexed=${res.unindexed.length}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const res = lintDocs(root);
  for (const row of formatFindings(res)) console.log(row);
  console.log(summary(res));
  process.exit(Object.values(res).some((l) => l.length) ? 1 : 0);
}
