// The run_code pre-flight scan (src/codeMode/precheck.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { literalPaths, checkPaths, closeMatches } from '../src/codeMode/precheck.ts';

const paths = (code) => literalPaths(code).map(p => p.path);

test('finds core and namespaced call sites, once each', () => {
  assert.deepEqual(paths('await cc.list_projects(); await cc.code_kanban.list_cards({}); cc.list_projects()'),
    ['cc.list_projects', 'cc.code_kanban.list_cards']);
});

test('whitespace around the dots is tolerated', () => {
  assert.deepEqual(paths('await cc\n  .list_projects ()'), ['cc.list_projects']);
});

test('comments, strings and template text are not code', () => {
  const code = [
    "// cc.in_line_comment()",
    "/* cc.in_block_comment() */",
    "const a = 'cc.in_single()';",
    'const b = "cc.in_double()";',
    'const c = `cc.in_template() ${1 + 1}`;',
    'const d = `${ cc.in_substitution() }`;',
  ].join('\n');
  assert.deepEqual(paths(code), []);
});

test('code after a literal that contains quotes and comment markers is still scanned', () => {
  assert.deepEqual(paths(`const s = "it's // not a comment"; await cc.real();`), ['cc.real']);
});

test('a member of something else named cc is ignored', () => {
  assert.deepEqual(paths('x.cc.nope(); foo$cc.nope(); cc_.nope()'), []);
});

test('a bracket call and a bare reference are not literal call sites', () => {
  assert.deepEqual(paths("cc['code-kanban'].list_cards(); const f = cc.list_projects;"), []);
});

test('checkPaths: a known core tool, a reserved method and a known plugin tool pass', () => {
  const names = new Set(['list_projects', 'code-kanban__list_cards']);
  assert.deepEqual(checkPaths(literalPaths('cc.list_projects(); cc.call("x"); cc.describe_tools(); cc.code_kanban.list_cards()'), names), []);
});

test('checkPaths: cc.<ns>.import(...) passes for any plugin namespace, tool-less ones included; top-level cc.import is an unknown core tool', () => {
  const names = new Set(['list_projects', 'code-browser__browser_info']);
  assert.deepEqual(checkPaths(literalPaths("await cc.code_browser.import(); await cc.code_browser.import('shot'); await cc.toolless.import()"), names), []);
  assert.deepEqual(checkPaths(literalPaths("await cc.import('code-browser')"), names).map(u => u.path), ['cc.import']);
});

test('checkPaths: an unknown core tool is reported with the nearest names', () => {
  const names = new Set(['list_projects', 'list_workspaces', 'spawn_instance']);
  const [u] = checkPaths(literalPaths('cc.list_projcts()'), names);
  assert.equal(u.path, 'cc.list_projcts');
  assert.deepEqual(u.suggestions, ['cc.list_projects']);
});

test('checkPaths: an unknown tool in a known namespace suggests that namespace\'s tools', () => {
  const names = new Set(['code-kanban__list_cards', 'code-kanban__read_card', 'code-arc__list_games']);
  const [u] = checkPaths(literalPaths('cc.code_kanban.list_card()'), names);
  assert.equal(u.path, 'cc.code_kanban.list_card');
  assert.deepEqual(u.suggestions, ['cc.code_kanban.list_cards']);
});

test('checkPaths: an unknown namespace suggests the nearest namespaces', () => {
  const names = new Set(['code-kanban__list_cards']);
  const [u] = checkPaths(literalPaths('cc.code_kanbn.list_cards()'), names);
  assert.deepEqual(u.suggestions, ['cc.code_kanban']);
});

test('checkPaths: a namespace spelled with underscores maps back to the hyphenated id', () => {
  const names = new Set(['code-kanban__list_cards']);
  assert.deepEqual(checkPaths(literalPaths('cc.code_kanban.list_cards()'), names), []);
});

test('closeMatches returns at most three, nearest first', () => {
  assert.deepEqual(closeMatches('read_card', ['read_cards', 'read_cart', 'read_carp', 'read_card_log', 'zzz']).length, 3);
  assert.deepEqual(closeMatches('abc', ['xyz']), []);
});

test('an escaped quote does not end a string literal', () => {
  assert.deepEqual(paths(String.raw`const s = "a \" cc.nope() b"; const t = 'it\'s cc.nope2()';`), []);
});

test('a regular-expression literal is not code, so a call-shaped pattern is not a call site', () => {
  assert.deepEqual(paths('const re = /cc.list_cards(x)/; return re.test(s);'), []);
  assert.deepEqual(paths('if (/cc\\.a\\(/.test(s)) await cc.real();'), ['cc.real']);
  assert.deepEqual(paths('return /[/]cc.nope()/g.test(s)'), []);
  // A pattern holding a quote is read as division and left as code: whatever
  // follows is then simply not found, never refused.
  assert.deepEqual(paths('x = s.replace(/"/g, "") + cc.after_regex_quote()'), []);
});

test('a division is still code: a call after it is found', () => {
  assert.deepEqual(paths('const half = total / 2; await cc.real(); const q = n / m;'), ['cc.real']);
});

test('a program that binds its own cc is not pre-checked', () => {
  for (const code of [
    'const cc = makeClient(); await cc.nope();',
    'let cc; cc = other(); await cc.nope();',
    'function run(cc) { return cc.nope(); }',
    'const f = (cc) => cc.nope();',
    'const f = async cc => cc.nope();',
    'const { cc } = holder; await cc.nope();',
    'function cc() {} cc.nope();',
  ]) assert.deepEqual(paths(code), [], code);
});

test('passing the injected cc along is not a binding: the call sites are still checked', () => {
  assert.deepEqual(paths('helper(cc); await cc.nope();'), ['cc.nope']);
});

test('a division is never read as a regex that ends inside a later string', () => {
  // The ambiguous reading bails at the quote and the rest of the LINE is left
  // unchecked (a miss, never a refusal); the next line is scanned again.
  assert.deepEqual(paths('const pct = (a + b) / total; const label = "w/xy cc.nope() here"; await cc.maybe();\nawait cc.list_projects();'), ['cc.list_projects']);
  assert.deepEqual(paths('const half = xs[0] / 2; const s = "a/bc cc.nope()";\nawait cc.real();'), ['cc.real']);
  assert.deepEqual(paths("const r = n / 2; const t = 'x/y cc.nope()';"), []);
});

test('a quote inside a regex pattern never lets a later string be read as code', () => {
  for (const quote of ['"', "'", '`']) {
    assert.deepEqual(paths(`const out = s.replace(/${quote}/g, "see cc.nope() here"); await cc.list_projects();`), [], quote);
    assert.deepEqual(paths(`text.replace(/${quote}/g, "x") + "call cc.nope()"`), [], quote);
  }
});

test('a quote-bearing regex does not make a later "const cc" string disable the check', () => {
  assert.deepEqual(paths('s.replace(/"/g, "const cc = 1");\nawait cc.nope();'), ['cc.nope']);
});

test('a condition that merely mentions cc is not a binding: the pre-check still runs', () => {
  for (const head of ['if (cfg.cc) {', 'if (cc.ready) {', 'while (cc) {', 'switch (cfg.cc) {', 'if (helper(cc)) {']) {
    assert.deepEqual(paths(`${head} await cc.real(); }`), ['cc.real'], head);
  }
});

test('every real binding position disables the pre-check', () => {
  for (const code of [
    'async function run(a, cc) { return cc.nope(); }',
    'const f = (a, cc) => cc.nope();',
    'try { x(); } catch (cc) { cc.nope(); }',
    'for (const cc of list) { cc.nope(); }',
    'const [cc] = list; cc.nope();',
    'var a = 1, cc = make(); cc.nope();',
    'class cc {} cc.nope();',
    'const o = { m(cc) { return cc.foo(); } };',
    'class K { m(cc) { return cc.foo(); } }',
    'class K { async m(a, cc) { return cc.foo(); } }',
    'let cc; cc ||= make(); await cc.nope();',
    'let cc; cc.nope();',
  ]) assert.deepEqual(paths(code), [], code);
});

test('a division inside a template substitution does not swallow the rest of the program', () => {
  assert.deepEqual(
    paths("const pct = `ratio ${ (a + b) / c }`; await cc.create_workspace({name:'side'}); await cc.nope();"),
    ['cc.create_workspace', 'cc.nope']);
});
