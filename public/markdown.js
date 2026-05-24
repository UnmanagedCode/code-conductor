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
//   | GFM pipe tables (with optional :--- / :---: / ---: alignment)
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
// The explicit [text](url) link alternative comes before the bare-URL
// autolink so an explicit Markdown link still wins when its URL would
// also match the autolink regex.
// We instantiate a fresh `RegExp` per renderInline call because the global
// /g lastIndex is shared, and renderInline recurses — a single shared
// regex causes the recursion to repeatedly re-match the same outer span
// (infinite loop / heap OOM).
const INLINE_PATTERN =
  '(\\*\\*[^*\\n]+?\\*\\*)|(\\*[^*\\n]+?\\*)|((?:^|\\s)_[^_\\n]+?_(?=\\s|[.,;:!?)\\]]|$))|(`[^`\\n]+?`)|(\\[[^\\]\\n]+?\\]\\([^)\\n]+?\\))|(\\bhttps?:\\/\\/[^\\s<>()\\[\\]]+)';

// Trailing punctuation that should not be part of an autolinked URL
// (e.g. the period in "see https://example.com.").
const URL_TRAILING_PUNCT = /[.,;:!?'")\]]+$/;

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
    } else if (m[6]) {
      let url = m[6];
      let trailing = '';
      const tm = url.match(URL_TRAILING_PUNCT);
      if (tm) { trailing = tm[0]; url = url.slice(0, -trailing.length); }
      if (SAFE_URL.test(url)) {
        const a = el('a', url);
        a.setAttribute('href', url);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        out.push(a);
      } else {
        out.push(url);
      }
      // Rewind lastIndex so the trimmed trailing punctuation is included
      // in the leading-text slice on the next iteration (or the final
      // tail push after the loop). Avoids both losing it and emitting it
      // twice.
      re.lastIndex -= trailing.length;
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
function looksLikeTableRow(line) {
  return line != null && line.includes('|') && line.trim() !== '';
}
// Separator row like "| --- | :---: | ---: |". Requires at least two columns
// (single-column "tables" aren't a thing in GFM and would collide with HR).
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
function looksLikeTableSeparator(line) {
  return line != null && TABLE_SEPARATOR_RE.test(line);
}
function isTableStart(line, next) {
  return looksLikeTableRow(line) && looksLikeTableSeparator(next);
}
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
function parseAlignments(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}
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
    if (isTableStart(line, lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = parseAlignments(lines[i + 1]);
      const width = header.length;
      const norm = (r) => r.length === width
        ? r
        : (r.length < width ? r.concat(Array(width - r.length).fill('')) : r.slice(0, width));
      const rows = [];
      i += 2;
      while (i < lines.length && looksLikeTableRow(lines[i]) && !startsAnyBlock(lines[i])) {
        rows.push(norm(splitTableRow(lines[i])));
        i++;
      }
      blocks.push({ type: 'table', header: norm(header), aligns, rows });
      continue;
    }
    // Paragraph — collect contiguous non-block lines.
    const para = [];
    while (i < lines.length && !isBlankLine(lines[i]) && !startsCodeFence(lines[i])
           && !startsHeading(lines[i]) && !startsHr(lines[i])
           && !startsUl(lines[i]) && !startsOl(lines[i]) && !startsBq(lines[i])
           && !isTableStart(lines[i], lines[i + 1])) {
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
      const pre = el('pre', code);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-code-copy';
      btn.textContent = 'Copy';
      let resetTimer = null;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = code.textContent;
        const flash = (label, cls) => {
          btn.textContent = label;
          btn.classList.remove('copied', 'failed');
          if (cls) btn.classList.add(cls);
          if (resetTimer) clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied', 'failed');
            resetTimer = null;
          }, 1200);
        };
        const p = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('clipboard unavailable'));
        p.then(() => flash('Copied', 'copied'))
         .catch(() => flash('Copy failed', 'failed'));
      });
      const wrap = document.createElement('div');
      wrap.className = 'md-code-wrap';
      wrap.appendChild(btn);
      wrap.appendChild(pre);
      return wrap;
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
    case 'table': {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      block.header.forEach((cell, idx) => {
        const th = el('th', ...renderInline(cell));
        if (block.aligns[idx]) th.style.textAlign = block.aligns[idx];
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        row.forEach((cell, idx) => {
          const td = el('td', ...renderInline(cell));
          if (block.aligns[idx]) td.style.textAlign = block.aligns[idx];
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }
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
