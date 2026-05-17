// Tiny safe Markdown → DOM renderer used for plan bodies (and reusable
// anywhere else we want to render a fixed markdown blob).
//
// Safety: every leaf piece of text is set via textContent. We never
// touch innerHTML and we never trust user-supplied HTML. Links are
// restricted to http(s) / relative / fragment / mailto schemes — anything
// else is rendered as literal text.
//
// Supported subset:
//   #..###### headings
//   **bold**, *italic*, _italic_, `inline code`
//   ```fenced code blocks``` (with optional language tag)
//   - / * / + unordered lists
//   1. ordered lists
//   > blockquotes
//   --- / *** / ___ horizontal rules
//   [text](url) links
//   blank-line-separated paragraphs

function el(tag, ...children) {
  const e = document.createElement(tag);
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

const SAFE_URL = /^(https?:\/\/|\/|#|mailto:)/i;

// Inline construct pattern — order matters: try **bold** before *italic*
// (bold appears as the first alternative so it wins for "**...**").
// We instantiate a fresh `RegExp` per renderInline call because the global
// /g lastIndex is shared, and renderInline recurses — a single shared
// regex causes the recursion to repeatedly re-match the same outer span
// (infinite loop / heap OOM).
const INLINE_PATTERN =
  '(\\*\\*[^*\\n]+?\\*\\*)|(\\*[^*\\n]+?\\*)|((?:^|\\s)_[^_\\n]+?_(?=\\s|[.,;:!?)\\]]|$))|(`[^`\\n]+?`)|(\\[[^\\]\\n]+?\\]\\([^)\\n]+?\\))';

export function renderInline(text) {
  const out = [];
  let cursor = 0;
  const re = new RegExp(INLINE_PATTERN, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) out.push(text.slice(cursor, m.index));
    if (m[1]) {
      out.push(el('strong', ...renderInline(m[1].slice(2, -2))));
    } else if (m[2]) {
      out.push(el('em', ...renderInline(m[2].slice(1, -1))));
    } else if (m[3]) {
      // _italic_ — preserve any leading whitespace match group.
      const lead = m[3].startsWith('_') ? '' : m[3][0];
      const body = m[3].replace(/^\s?_/, '').replace(/_$/, '');
      if (lead) out.push(lead);
      out.push(el('em', ...renderInline(body)));
    } else if (m[4]) {
      out.push(el('code', m[4].slice(1, -1)));
    } else if (m[5]) {
      const lm = m[5].match(/^\[(.+?)\]\((.+?)\)$/);
      if (lm && SAFE_URL.test(lm[2])) {
        const a = el('a', ...renderInline(lm[1]));
        a.setAttribute('href', lm[2]);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        out.push(a);
      } else {
        out.push(m[5]); // unsafe URL — render as literal text
      }
    }
    cursor = re.lastIndex;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  // Collapse single-string results to that string for convenience.
  return out;
}

function isBlankLine(line) { return !line || !line.trim(); }
function startsHeading(line) { return /^#{1,6}\s+\S/.test(line); }
function startsCodeFence(line) { return line.startsWith('```'); }
function startsHr(line) { return /^[-*_]{3,}\s*$/.test(line.trim()); }
function startsUl(line) { return /^[\-*+]\s+/.test(line); }
function startsOl(line) { return /^\d+\.\s+/.test(line); }
function startsBq(line) { return line.startsWith('> ') || line === '>'; }
function startsAnyBlock(line) {
  return isBlankLine(line) || startsHeading(line) || startsCodeFence(line)
    || startsHr(line) || startsUl(line) || startsOl(line) || startsBq(line);
}

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }

    if (startsCodeFence(line)) {
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !startsCodeFence(lines[i])) { code.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: 'code', lang, code: code.join('\n') });
      continue;
    }
    if (startsHr(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (startsHeading(line)) {
      const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
      i++; continue;
    }
    if (startsBq(line)) {
      const inner = [];
      while (i < lines.length && (startsBq(lines[i]) || (!startsAnyBlock(lines[i]) && !isBlankLine(lines[i]) && lines[i].startsWith(' ')))) {
        inner.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: inner.join('\n') });
      continue;
    }
    if (startsUl(line)) {
      const items = [];
      while (i < lines.length && startsUl(lines[i])) {
        items.push(lines[i].replace(/^[\-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (startsOl(line)) {
      const items = [];
      while (i < lines.length && startsOl(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    // Paragraph — collect contiguous non-block lines.
    const para = [];
    while (i < lines.length && !isBlankLine(lines[i]) && !startsCodeFence(lines[i])
           && !startsHeading(lines[i]) && !startsHr(lines[i])
           && !startsUl(lines[i]) && !startsOl(lines[i]) && !startsBq(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

function blockToNode(block) {
  switch (block.type) {
    case 'heading': {
      const tag = 'h' + Math.min(Math.max(block.level, 1), 6);
      return el(tag, ...renderInline(block.text));
    }
    case 'paragraph':
      return el('p', ...renderInline(block.text));
    case 'code': {
      const code = el('code', block.code);
      if (block.lang) code.dataset.lang = block.lang;
      return el('pre', code);
    }
    case 'ul':
    case 'ol': {
      const list = document.createElement(block.type);
      for (const item of block.items) {
        const li = el('li', ...renderInline(item));
        list.appendChild(li);
      }
      return list;
    }
    case 'blockquote':
      return el('blockquote', ...renderInline(block.text));
    case 'hr':
      return document.createElement('hr');
    default:
      return el('p', String(block.text ?? ''));
  }
}

/** Replace rootEl's children with rendered markdown. */
export function renderMarkdownInto(rootEl, text) {
  rootEl.textContent = '';
  try {
    for (const block of parseMarkdown(text)) {
      rootEl.appendChild(blockToNode(block));
    }
  } catch (e) {
    // On any parse error, fall back to a single <pre> with the raw text
    // so the user never sees a blank card.
    rootEl.textContent = '';
    rootEl.appendChild(el('pre', String(text ?? '')));
  }
}
