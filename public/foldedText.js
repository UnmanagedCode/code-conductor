// Folded bubble bodies (wake-callback and skill-load `<details>`): lazy
// markdown rendering + raw/md toggle + copy, built on first expand and
// reused after. Kept out of userText.js because that module is imported
// server-side-adjacent code paths never touch, while this one is DOM-only;
// kept out of wakeCallback.js because the server imports that module and it
// must stay free of DOM dependencies.

import { el } from './dom.js';
import { buildUserText } from './userText.js';
import { renderMarkdownInto } from './markdown.js';

// Mounts a lazily-built body + controls into `details` on its first
// toggle-to-open. Gated on `details.open`, not merely the event: real
// browsers can dispatch `toggle` while the element is already closed again
// (e.g. a rapid open+close coalesced into one event), and happy-dom
// dispatches it synchronously so a naive event-only gate would build eagerly
// in tests. No `{once:true}` — the listener must keep gating later toggles
// on `open` so a reopen never re-runs the build.
export function mountFoldedText(details, text, { renderInto } = {}) {
  let built = false;
  details.addEventListener('toggle', () => {
    if (built || !details.open) return;
    built = true;
    const { body, controls } = buildUserText(text, renderInto ? { renderInto } : {});
    details.append(el('div', { class: 'fold-controls' }, controls), body);
  });
}

// Wake bodies are `flattenPayload`'s output (src/mcp/content.ts): line 1 is
// always `JSON.stringify(meta)` (JSON never emits a raw newline), so it is
// rendered as a muted textContent-only line rather than through the markdown
// parser — the JSON's underscores/prose would otherwise mangle into
// italics/bold. The rest renders as markdown.
export function renderWakeBodyInto(container, text) {
  const nl = text.indexOf('\n');
  const meta = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? '' : text.slice(nl + 1);
  renderMarkdownInto(container, rest);
  container.prepend(el('div', { class: 'wake-meta' }, meta));
}
