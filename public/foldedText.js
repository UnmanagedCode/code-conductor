// Folded bubble bodies (wake-callback, skill-load, renew-seed and forward-frame
// `<details>`):
// lazy markdown rendering + raw/md toggle + copy, built on first expand and
// reused after. Kept out of userText.js: that module's `buildUserText` is
// the one generic, eagerly-built body shared by every user-text bubble —
// the lazy build-on-first-expand mounting and the wake/renew/forward-specific
// section splitting are concerns specific to these collapsible kinds, so they
// live here instead of forking userText.js's single responsibility. Kept out
// of wakeCallback.js/renewSeed.js/forwardFrame.js because the server imports
// those modules and they must stay free of DOM dependencies.

import { el } from './dom.js';
import { buildUserText } from './userText.js';
import { renderMarkdownInto } from './markdown.js';
import { parseRenewSeed, splitSummarySections } from './renewSeed.js';
import { splitForwardedMessages } from './forwardFrame.js';

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

// Renders a renew_session reseed's full text as labelled sections: one per
// summary heading (falling back to a single "Handoff summary" section when
// none matched), then the conductor's follow-up directive (if any), then the
// mechanical state block. The state block renders as literal textContent,
// never markdown — same reasoning as .wake-meta: a stray backtick or
// asterisk in a worktree/project name would otherwise mangle into an element.
export function renderRenewSeedInto(container, text) {
  container.textContent = '';
  const parsed = parseRenewSeed(text);
  if (!parsed) {
    renderMarkdownInto(container, text);
    return;
  }
  for (const { title, body } of splitSummarySections(parsed.summary)) {
    const bodyDiv = el('div', { class: 'renew-section-body' });
    renderMarkdownInto(bodyDiv, body);
    container.appendChild(el('section', { class: 'renew-section' },
      el('div', { class: 'renew-section-label' }, title ?? 'Handoff summary'),
      bodyDiv,
    ));
  }
  if (parsed.followUp) {
    const bodyDiv = el('div', { class: 'renew-section-body' });
    renderMarkdownInto(bodyDiv, parsed.followUp);
    container.appendChild(el('section', { class: 'renew-section' },
      el('div', { class: 'renew-section-label' }, 'Conductor\'s follow-up directive'),
      bodyDiv,
    ));
  }
  if (parsed.state) {
    container.appendChild(el('section', { class: 'renew-section' },
      el('div', { class: 'renew-section-label' }, 'Mechanical state (server-generated)'),
      el('div', { class: 'renew-state' }, parsed.state),
    ));
  }
}

// Renders a send_prompt({forward}) frame's payload (parseForwardFrame's
// `payload`) as one labelled markdown section per forwarded message. Markdown,
// like the renew summary: the bodies are the source worker's own prose, plans
// and questions. One section per message keeps a truncated message's unclosed
// code fence from swallowing the messages after it.
export function renderForwardBodyInto(container, payload) {
  container.textContent = '';
  const bodies = splitForwardedMessages(payload);
  bodies.forEach((body, i) => {
    const bodyDiv = el('div', { class: 'forward-section-body' });
    renderMarkdownInto(bodyDiv, body);
    container.appendChild(el('section', { class: 'forward-section' },
      el('div', { class: 'forward-section-label' },
        bodies.length > 1 ? `Message ${i + 1}/${bodies.length}` : 'Forwarded output'),
      bodyDiv,
    ));
  });
}
