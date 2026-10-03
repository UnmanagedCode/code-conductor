// Line-ending helpers for the files cc reads and rewrites inside a user's repo
// (CONVENTIONS.md, CLAUDE.md). Git for Windows (`core.autocrlf=true`) checks
// those out with CRLF, so a marker read must not see the `\r`, and a rewrite
// keeps the file's own ending rather than producing a mixed-EOL file.

// Line 1 of `text`, without its `\r\n` / `\n`.
export function firstLine(text: string): string {
  return text.split('\n', 1)[0].replace(/\r$/, '');
}

// `\r\n` when line 1 of `text` ends with it, else `\n` (null or no newline too).
export function eolOf(text: string | null): '\r\n' | '\n' {
  if (text === null) return '\n';
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

// `text` with every line ending converted to `eol`.
export function withEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
