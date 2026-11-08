// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tokenizeJs } from './jsTokens';

const FIXTURES: Record<string, string> = {
  empty: '',
  'escaped quotes': `'it\\'s' + "a\\"b"`,
  'newline ends a string': "'unterminated\nnext",
  'trailing backslash': '"ends with backslash\\',
  'open block comment': '/* never closed',
  'open substitution': '`open ${x ',
  'open template': '`never closed',
  'nested template': '`a ${ `b ${c}` } d`',
  'object in substitution': '`${ {k: 1}.k }`',
  division: 'a / b / c',
  regex: 'x = /a\\/b[/]/g.test(s)',
  'open regex': 'return /unclosed',
  'line continuation': '"line\\\ncont"',
  numbers: '0x1F + 1_000 + 1.5e3 + .5 + 10n',
  crlf: 'a = 1;\r\n// c\r\nb = "x"\r\n',
  'non-ascii': "'héllo — 😀'",
};

const ofKind = (s: string, kind: string) => tokenizeJs(s).filter((t) => t.kind === kind).map((t) => t.text);

describe('tokenizeJs is lossless', () => {
  for (const [name, src] of Object.entries(FIXTURES)) {
    it(`reproduces ${name} exactly with no empty token`, () => {
      const toks = tokenizeJs(src);
      expect(toks.map((t) => t.text).join('')).toBe(src);
      expect(toks.every((t) => t.text.length > 0)).toBe(true);
    });
  }

  it('reproduces 5000 seeded random strings over the lexer-hostile alphabet', () => {
    let a = 0x9e3779b9;
    const rnd = () => { // mulberry32
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = ["'", '"', '`', '\\', '/', '*', '$', '{', '}', '[', ']', '\n', ' ', 'a', '1', '.', 'x'];
    for (let n = 0; n < 5000; n++) {
      const len = Math.floor(rnd() * 41);
      let s = '';
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const toks = tokenizeJs(s);
      expect(toks.map((t) => t.text).join(''), `input ${JSON.stringify(s)}`).toBe(s);
      expect(toks.every((t) => t.text.length > 0), `empty token for ${JSON.stringify(s)}`).toBe(true);
    }
  });
});

describe('tokenizeJs kinds', () => {
  it('splits adjacent strings at their own closing quotes', () => {
    expect(ofKind(FIXTURES['escaped quotes'], 'string')).toEqual(["'it\\'s'", '"a\\"b"']);
  });
  it('a line comment stops before the newline', () => {
    expect(ofKind('// c "q"\nx', 'comment')).toEqual(['// c "q"']);
    expect(ofKind('// c "q"\nx', 'string')).toEqual([]);
  });
  it('an open block comment is one comment to the end', () => {
    expect(ofKind('/* never closed', 'comment')).toEqual(['/* never closed']);
  });
  it('a newline ends an unterminated string before it', () => {
    expect(ofKind("'unterminated\nnext", 'string')).toEqual(["'unterminated"]);
  });
  it('template text is string, substitution bodies are code, nesting recurses', () => {
    const strs = ofKind('`a ${ `b ${c}` } d`', 'string');
    expect(strs).toContain('`a ');
    expect(strs).toContain(' d`');
    expect(strs.join('')).not.toContain('c');
  });
  it('a slash after an operand divides', () => {
    expect(ofKind('a / b / c', 'regex')).toEqual([]);
  });
  it('a slash where an expression starts opens a regex, a slash inside [] does not close it', () => {
    expect(ofKind('x = /a\\/b[/]/g.test(s)', 'regex')).toEqual(['/a\\/b[/]/g']);
  });
  it('keywords match whole identifiers only', () => {
    const toks = tokenizeJs('const constant');
    expect(toks.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['const']);
  });
  it('numbers are numbers, digits inside identifiers are not', () => {
    expect(ofKind('a1 0x1F', 'number')).toEqual(['0x1F']);
  });
});
