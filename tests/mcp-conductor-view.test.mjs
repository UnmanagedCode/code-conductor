// The conductor-facing instance projection is an EXPLICIT ALLOWLIST, and the
// `list_sessions` tool description must document exactly what it emits.
//
// The defect this guards: toConductorView used to be
// `({id, callerInstanceId, ...rest}) => rest`, so every field ever added to
// Instance.summary() was published to conductors automatically. That is how the
// misleading `sonnetWindow` reached every conductor-facing return while tools.ts
// documented only 13 keys. The surface being UNDOCUMENTED was the bug — not its
// width — so the allowlist is close to parity and the tool description is
// pinned against it here rather than by review.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { CONDUCTOR_VIEW_KEYS, LIST_ONLY_KEYS } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const TOOLS_SRC = path.join(__dirname, '..', 'src', 'mcp', 'tools.ts');
const HANDLERS_SRC = path.join(__dirname, '..', 'src', 'mcp', 'handlers.ts');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_INSTANCE }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', name, params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  const raw = body.result.content[0].text;
  try { return JSON.parse(raw); }
  catch { assert.fail(`tools/call ${name} did not return JSON: ${raw}`); }
}

const sorted = (a) => a.slice().sort();

// Withheld = the COMPLEMENT of the allowlist over what summary() actually
// emits. The literal list and the derived difference below pin DIFFERENT
// things, and both are needed:
//   • the literal pins INTENT — moving one of these into CONDUCTOR_VIEW_KEYS
//     must fail here, which a derived expectation could never catch (it would
//     move with the change);
//   • the derived difference pins the LITERAL — a new summary() field nobody
//     allowlisted fails that assertion, and (as of the mutation run for card
//     2026-0176) that assertion ALONE in the whole suite: the wire loop below
//     never sees it. That is the drift by which `playbookEnforcement` and
//     `overageStoppedUnarmed` went undocumented.
// Three surfaces carry this set: this array, the `Excluded on purpose` comment
// on CONDUCTOR_VIEW_KEYS, and docs/protocol.md → Emitted handles. Of those three
// surfaces, only this array is pinned — no test reads either prose copy, so
// adding a name here alone turns the suite green with both stale. Update all
// three by hand, together.
const WITHHELD_KEYS = [
  'id', 'callerInstanceId', 'debugDir', 'autoApprovePlan',
  'playbookEnforcement', 'interrupting', 'overageStoppedUnarmed',
];

// Pull the documented key names out of the single `{…}` block in the
// list_sessions description. Exported so the vacuity guard below can reuse it.
export function documentedKeys(toolsSource) {
  const at = toolsSource.indexOf("name: 'list_sessions'");
  assert.ok(at >= 0, 'list_sessions tool not found');
  const desc = toolsSource
    .slice(at, toolsSource.indexOf('inputSchema', at))
    // The description is built by JS string concatenation, so a key list can be
    // split across source lines as `…, ' +\n  'backend, …`. Rejoin before parsing.
    .replace(/['"]\s*\+\s*['"]/g, '');
  const brace = desc.match(/\{([^}]*)\}/);
  assert.ok(brace, 'the list_sessions description must carry a {key, key, …} block');
  return brace[1].split(',').map(k => k.trim()).filter(Boolean);
}

test('the documented key list matches what toConductorView emits, one-for-one', async () => {
  const src = await fs.readFile(TOOLS_SRC, 'utf8');
  const documented = documentedKeys(src);
  // Three fields are appended downstream by listSessions, not by the
  // projection: `awaitingWake` (added by list()), and `playbook`/`stage`
  // (joined from the sessionId-keyed playbook projection). None of them exists on
  // InstanceSummary, so putting them in the allowlist would publish permanently-
  // undefined fields on the four other projections — hence list_sessions
  // documents exactly the allowlist plus these three.
  const expected = [...CONDUCTOR_VIEW_KEYS, ...LIST_ONLY_KEYS];

  // Non-vacuity: a regex that matched nothing would compare [] to [] under a
  // sloppier assertion. Pin the count first, then the contents.
  assert.ok(documented.length >= 20, `parsed only ${documented.length} keys — the description shape changed`);
  assert.equal(documented.length, 31);
  assert.equal(CONDUCTOR_VIEW_KEYS.length, 28);
  assert.deepEqual(sorted(documented), sorted(expected));
});

test('the doc-drift gate actually fails on a mangled description (vacuity guard)', () => {
  // Proves the parser can't silently succeed: if the {…} block loses a key, the
  // comparison above must notice. Run against a deliberately broken source.
  const mangled = `
    { name: 'list_sessions',
      description: 'Each entry carries {project, sessionId}. blah',
      inputSchema: {} }`;
  const parsed = documentedKeys(mangled);
  assert.deepEqual(parsed, ['project', 'sessionId']);
  assert.notDeepEqual(sorted(parsed), sorted([...CONDUCTOR_VIEW_KEYS, ...LIST_ONLY_KEYS]));
  // …and a description with no brace block is a hard error, not an empty pass.
  assert.throws(() => documentedKeys(`{ name: 'list_sessions', description: 'no keys here', inputSchema: {} }`));
});

test('every conductor-facing projection emits exactly the allowlist', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });

  const spawned = await callTool('spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', model: 'claude-haiku-4-5',
  });
  const sessionId = spawned.sessionId;
  assert.ok(sessionId);
  await waitFor(() => instances.liveForSession(sessionId)?.status === 'idle');

  // spawn_instance
  assert.deepEqual(sorted(Object.keys(spawned)), sorted(CONDUCTOR_VIEW_KEYS));

  // list_sessions is NOT checked here: it returns a plain-text rendering, not
  // JSON, so its emitted key set is not observable over the wire. Note this
  // file's gates — and the projection checks below — only bind the allowlist to
  // the tool DESCRIPTION and to the four JSON projections. What binds it to the
  // rendering a caller actually sees is
  // tests/mcp-text-render.test.mjs → "list_sessions renders every allowlisted
  // field". Both are required: a field can satisfy every check here and still
  // never be emitted.

});

// Reduce a TS source to its CODE SKELETON: comments removed, and the CONTENTS of
// string / template / regex literals emptied (delimiters and `${}` braces stay,
// so nesting is preserved). Every scrape below reads this rather than the raw
// text, because a scrape of raw text is satisfiable by a COMMENT — a handler
// could hand-roll a projection and still match `conductorRowView(` from a
// comment mentioning it, which is not a hypothetical: it was demonstrated
// against an earlier version of this test.
//
// ESCAPES: every branch that scans to a closing delimiter treats `\` as
// escaping the next character, so an escaped quote / backtick / `]` / `/` never
// ends its literal early. Each of those four branches has its own fixture
// below; a one-character regression in any of them is otherwise invisible,
// because a mis-parse degrades this file into a green suite that checks
// nothing. The two comment branches need no escape handling — JS has no
// escapes in comments.
function codeSkeleton(src) {
  let out = '';
  // Frames, so `${ … }` inside a template returns to template state at ITS
  // closing brace and not at an object literal's.
  const stack = [{ template: false, depth: 0 }];
  const prevSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k];
    return '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    const top = stack[stack.length - 1];
    if (top.template) {
      if (c === '\\') { i += 2; continue; }             // escaped ` does not close
      if (c === '`') { out += '`'; stack.pop(); i++; continue; }
      if (c === '$' && d === '{') { out += '${'; stack.push({ template: false, depth: 0 }); i += 2; continue; }
      i++; continue;                                   // template TEXT is dropped
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      out += c; i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      out += c; i++; continue;                         // string CONTENTS dropped
    }
    if (c === '`') { out += '`'; stack.push({ template: true, depth: 0 }); i++; continue; }
    // Regex vs division, decided by the token before the slash. `{` is in the
    // set because of `${/re/.test(x)}` and `{ /re/.test(x) }` — leaving it out
    // is not a near-miss: the slash is then emitted as division, the pattern
    // leaks into the skeleton as code, and any brace inside it unbalances the
    // walk for everything that follows.
    if (c === '/' && '(,=:[!&|?;+-*%<>~^{}'.includes(prevSignificant() || '(')) {
      i++;
      while (i < src.length && src[i] !== '/') {
        if (src[i] === '\\') i++;                      // escaped / does not close
        else if (src[i] === '[') {                     // a class may hold an unescaped /
          i++;
          while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
        }
        i++;
      }
      i++; continue;
    }
    if (c === '{') { top.depth++; out += c; i++; continue; }
    if (c === '}') {
      if (top.depth === 0 && stack.length > 1) { out += '}'; stack.pop(); i++; continue; }
      top.depth--; out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// A mis-parse must be LOUD. Every gate below extracts function bodies by brace
// matching, so a skeleton whose delimiters do not balance is not a weaker gate
// — it is a gate reading the wrong text while passing. This runs on every
// skeleton the gate consumes, real or synthetic, so no future literal can
// quietly degrade the file into a suite that checks nothing.
function assertWellFormedSkeleton(sk, label) {
  const count = (re) => (sk.match(re) || []).length;
  for (const [open, close, name] of [[/\{/g, /\}/g, 'brace'], [/\(/g, /\)/g, 'paren'], [/\[/g, /\]/g, 'bracket']]) {
    assert.equal(count(open), count(close), `${label}: ${name}s do not balance — codeSkeleton mis-parsed a literal`);
  }
  for (const [re, name] of [[/'/g, 'single-quote'], [/"/g, 'double-quote'], [/`/g, 'backtick']]) {
    assert.equal(count(re) % 2, 0, `${label}: odd number of ${name} delimiters — codeSkeleton mis-parsed a literal`);
  }
}

// The skeleton is what every gate below stands on, so it is pinned itself:
// a stripper that quietly returned its input would make all of them vacuous.
test('codeSkeleton drops comments and literal contents but keeps the code', () => {
  const sk = codeSkeleton([
    "const a = 'toConductorView(';        // conductorRowView(",
    '/* toConductorView( */',
    'function real() { return toConductorView(x); }',
    'const t = `text conductorRowView( ${ inner(1) } more`;',
    "const r = s.replace(/'/g, 'x');",
  ].join('\n'));
  assert.ok(sk.includes('function real() { return toConductorView(x); }'), 'code survives');
  assert.ok(sk.includes('inner(1)'), 'a template EXPRESSION is code and survives');
  assert.equal(sk.split('toConductorView(').length - 1, 1,
    'the comment, the block comment and the string mention are all gone');
  assert.ok(!sk.includes('conductorRowView'),
    'a comment or template-text mention must not survive');
  assertWellFormedSkeleton(sk, 'mixed fixture');
});

test('codeSkeleton honours a backslash escape in every branch that has one', () => {
  // One fixture per escape-bearing branch, each built so that MIS-handling the
  // backslash ends the literal early and leaks the hidden mention as code.
  // Without these, a one-character `i += 2` → `i += 1` regression is invisible.
  const hidden = (sk, where) => assert.ok(!sk.includes('conductorRowView'),
    `${where}: an escaped delimiter ended the literal early and leaked its contents`);

  // 1. STRING: an escaped quote must not close the string.
  hidden(codeSkeleton("const s = 'a \\' conductorRowView( b'; const k = 1;"), 'string');
  // 2. TEMPLATE: an escaped backtick must not close the template.
  hidden(codeSkeleton('const t = `a \\` conductorRowView( b`; const k = 1;'), 'template');
  // 3. REGEX: an escaped slash must not close the pattern.
  hidden(codeSkeleton('const r = /a\\/ conductorRowView( b/; const k = 1;'), 'regex');
  // 4. REGEX CHARACTER CLASS: an escaped `]` must not close the class, which
  //    would hand the rest of the class back to the outer scan and end the
  //    regex at the next `/`.
  const cls = codeSkeleton('const r = /[\\]/] conductorRowView( x/; const k = 1;');
  hidden(cls, 'regex class');
  assert.ok(cls.includes('const k = 1;'), 'the code after the literal must survive');

  // The regex-start decision, which is where the one real defect was: after `${`
  // and after `{`, a slash begins a PATTERN, not a division. Get it wrong and
  // the pattern leaks into the skeleton as code — brackets and braces and all.
  // Each fixture is written so that the leak is DELIMITER-BEARING, since a
  // pattern that leaked but happened to balance would prove nothing.
  for (const [sk, where] of [
    [codeSkeleton('const t = `a ${/[/]/.test(v)} b`; function f(){ return 1; }'), 'inside ${…}'],
    [codeSkeleton('function f(){ /x{2/.test(v); return 1; }'), 'at the head of a block'],
  ]) {
    assertWellFormedSkeleton(sk, `regex ${where}`);
    assert.ok(!sk.includes('/'), `${where}: a pattern leaked into the skeleton: ${sk}`);
  }
});

// The body of `name`, by brace matching on the skeleton (where no brace can
// hide in a comment or a string).
function bodyOf(skeleton, signature) {
  const at = skeleton.indexOf(signature);
  assert.ok(at >= 0, `not found: ${signature}`);
  // Walk past the PARAMETER list first — every handler here destructures its
  // args, so the first `{` after the name opens a parameter pattern, not a body.
  let i = at + signature.length;   // signature ends with the opening paren
  for (let depth = 1; depth > 0; i++) {
    assert.ok(i < skeleton.length, `unterminated parameter list for ${signature}`);
    if (skeleton[i] === '(') depth++;
    else if (skeleton[i] === ')') depth--;
  }
  const open = skeleton.indexOf('{', i);
  assert.ok(open > 0, `no body for ${signature}`);
  let depth = 0;
  for (let i = open; i < skeleton.length; i++) {
    if (skeleton[i] === '{') depth++;
    else if (skeleton[i] === '}' && --depth === 0) return skeleton.slice(open, i + 1);
  }
  assert.fail(`unterminated body for ${signature}`);
}

// The three checks, as a function, so the vacuity guard below can run the SAME
// gate against sources that deliberately bypass the projection.
function assertRoutesThroughProjection(src) {
  // Before anything reads it: a skeleton whose delimiters do not balance means
  // codeSkeleton mis-parsed a literal, and every bodyOf below would be slicing
  // at the wrong offsets while passing.
  assertWellFormedSkeleton(src, 'handlers skeleton');
  // listSessions and describeSession project through `conductorRowView` — the
  // ONE list-row projection, which is itself built on toConductorView, so the
  // invariant holds through exactly one extra hop. Either name counts; a
  // hand-rolled projection names neither, which is the polarity that matters.
  //
  // WHAT THIS ENFORCES, EXACTLY: that each handler CALLS a shared projection —
  // not that the call's value is what it returns. `void conductorRowView(r);
  // return {…}` passes here. That gap is deliberate and bounded, not an
  // oversight: closing it needs value-flow analysis, which a text scrape cannot
  // do and which a determined author defeats anyway. What actually reaches a
  // conductor is pinned two layers down — `instanceRows` renders a fixed field
  // list (so a smuggled key never reaches the text) and tests/mcp-contract
  // asserts the shape over the wire. Read this gate as "no handler quietly
  // stops naming the shared projection", which is the drift it exists to catch.
  for (const fn of ['listSessions', 'describeSession', 'spawnInstance']) {
    const body = bodyOf(src, `export async function ${fn}(`);
    assert.match(body, /toConductorView\(|conductorRowView\(/,
      `${fn} must CALL a shared projection (toConductorView / conductorRowView) — `
      + 'this checks the call is there, not that its value is what the handler returns');
  }
  // The extra hop is only safe while it IS a hop: conductorRowView must itself
  // call toConductorView. Without this, rewriting it to project independently
  // leaves every other gate here green.
  assert.match(bodyOf(src, 'function conductorRowView('), /toConductorView\(/,
    'conductorRowView must build ON toConductorView, not beside it');

  // …and there is exactly one definition of each.
  assert.equal(src.split('function toConductorView(').length - 1, 1);
  assert.equal(src.split('function conductorRowView(').length - 1, 1);

  // The strongest form of the same invariant, and the one that does not depend
  // on a bypass being spelled with either helper's name: the allowlist is READ
  // in exactly one place in the module — inside toConductorView. Any second
  // projection driven by CONDUCTOR_VIEW_KEYS, anywhere, fails here.
  assert.equal(src.split('CONDUCTOR_VIEW_KEYS').length - 1, 2,
    'CONDUCTOR_VIEW_KEYS must appear exactly twice: its declaration and its one read');
  assert.equal(bodyOf(src, 'function toConductorView(').split('CONDUCTOR_VIEW_KEYS').length - 1, 1,
    'that one read must be the one inside toConductorView');
}

test('every worker-summary handler routes through the single projection', async () => {
  // Defense-in-depth behind spawn_instance's wire check above. This scrape pins
  // what a key-set check cannot: that every worker-summary handler routes
  // through the ONE shared projection. A handler that hand-rolled its own projection emitting exactly
  // CONDUCTOR_VIEW_KEYS would pass its wire check but fail here — a second
  // projection is exactly how a field escapes the documented list.
  const src = codeSkeleton(await fs.readFile(HANDLERS_SRC, 'utf8'));
  // Vacuity: the skeleton is still the module, and is no longer its comments.
  assert.ok(src.includes('export const CONDUCTOR_VIEW_KEYS'), 'the skeleton is still handlers.ts');
  assert.ok(!src.includes('Never hand-roll a second one'), 'the skeleton still carries comment prose');
  assertRoutesThroughProjection(src);
});

// Built as in-memory sources — nothing on disk is touched. Each is a bypass that
// the PREVIOUS version of this gate accepted, so this is the proof that the gate
// above is fail-by-default rather than true-by-accident.
const fakeModule = ({ rowView, listBody } = {}) => `
export const CONDUCTOR_VIEW_KEYS = ['project', 'sessionId'];
function toConductorView(summary) {
  const out = {};
  for (const k of CONDUCTOR_VIEW_KEYS) out[k] = summary[k];
  return out;
}
function conductorRowView(row, proj) {
  ${rowView ?? 'return { ...toConductorView(row), awaitingWake: row.awaitingWake };'}
}
export async function listSessions(args, { instances }) {
  ${listBody ?? 'return instances.list().map(r => conductorRowView(r, null));'}
}
export async function describeSession({ sessionId }, { instances }) {
  return conductorRowView(instances.list()[0], null);
}
export async function spawnInstance(args, { instances }) {
  return toConductorView(instances.create(args).summary());
}
`;

test('the projection gate actually fails on a bypass (vacuity guard)', () => {
  // Positive control first: the shape itself must PASS, or the two negatives
  // below would prove nothing about the bypasses specifically.
  assertRoutesThroughProjection(codeSkeleton(fakeModule()));

  // HOLE 1 — a handler hand-rolls a projection while a COMMENT mentioning
  // conductorRowView( satisfies a raw-text scrape.
  assert.throws(() => assertRoutesThroughProjection(codeSkeleton(fakeModule({
    listBody: '// rows come from conductorRowView( upstream\n'
      + "    return instances.list().map(r => ({ project: r.project, sessionId: r.sessionId }));",
  }))), /must CALL a shared projection/);

  // HOLE 2 — conductorRowView keeps its name and its call sites, but stops
  // routing through toConductorView and projects the allowlist itself.
  assert.throws(() => assertRoutesThroughProjection(codeSkeleton(fakeModule({
    rowView: 'const out = {};\n'
      + '  for (const k of CONDUCTOR_VIEW_KEYS) out[k] = row[k];\n'
      + '  return out;',
  }))), /conductorRowView must build ON toConductorView/);

  // HOLE 3 — the allowlist-read check, which is the one that does not depend on
  // a bypass being spelled with either helper's name. Here every other check is
  // satisfied — both helpers exist, both are called, the hop is intact — and a
  // SECOND projection is driven off CONDUCTOR_VIEW_KEYS beside them.
  assert.throws(() => assertRoutesThroughProjection(codeSkeleton(fakeModule({
    listBody: 'const rows = instances.list().map(r => conductorRowView(r, null));\n'
      + '  const extra = {};\n'
      + '  for (const k of CONDUCTOR_VIEW_KEYS) extra[k] = args[k];\n'
      + '  return rows.concat(extra);',
  }))), /exactly twice: its declaration and its one read/);
});

test('the projection publishes contextWindowTokens and withholds sonnetWindow / instance ids', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo2' });
  const view = await callTool('spawn_instance', {
    project: 'demo2', mode: 'bypassPermissions', model: 'claude-haiku-4-5',
  });

  // The replacement field, as a real number resolved from {backend, model}.
  assert.equal(view.contextWindowTokens, 200_000);
  assert.equal(view.backend, 'claude');
  assert.equal(view.model, 'claude-haiku-4-5');

  // The withheld set, bound to its owner: summary() minus the allowlist must be
  // exactly WITHHELD_KEYS. `sonnetWindow` is NOT in that difference — it is gone
  // from summary() entirely — so it stays a separate regression sentinel.
  const inst = instances.liveForSession(view.sessionId);
  assert.ok(inst, 'the spawned worker must still be live to read its summary()');
  const emitted = Object.keys(inst.summary());
  assert.deepEqual(
    sorted(emitted.filter(k => !CONDUCTOR_VIEW_KEYS.includes(k))),
    sorted(WITHHELD_KEYS),
    'summary() minus CONDUCTOR_VIEW_KEYS must be exactly the documented withheld set',
  );
  for (const gone of ['sonnetWindow', ...WITHHELD_KEYS]) {
    assert.ok(!(gone in view), `${gone} must not reach the conductor view`);
  }
});

test('cwd is present and absolute — the conductor self-identification check reads it', async () => {
  // A conductor confirms its own cwd ends in `.conduct` and stops if it does not
  // (i.e. it is running inside a worker). A present-but-null cwd would silently
  // disable that check, so assert a usable value, not just the key.
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo3' });
  const view = await callTool('spawn_instance', {
    project: 'demo3', mode: 'bypassPermissions', model: 'claude-haiku-4-5',
  });
  assert.equal(typeof view.cwd, 'string');
  assert.ok(path.isAbsolute(view.cwd), `cwd must be absolute, got ${view.cwd}`);
  assert.ok(view.cwd.endsWith('demo3'));
});
