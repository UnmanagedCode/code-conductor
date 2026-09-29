// The compaction bubble: one note per context compaction, the same live and
// after a reload. A header names the trigger and token counts; the CLI's
// injected summary is folded beneath it (collapsed, lazy markdown body, like
// the renew-seed bubble). It is deliberately not a `.msg.user`: no role row, no
// rewind/fork controls.

import { el } from './dom.js';
import { mountFoldedText } from './foldedText.js';

const fmt = (n) => n.toLocaleString();

// Header text for each state. `state`: 'running' | 'done' | 'failed'.
export function compactionLabel({ state, trigger = null, preTokens = null, postTokens = null, error = null }) {
  if (state === 'running') return 'Compacting context…';
  if (state === 'failed') return error ? `Compaction failed: ${error}` : 'Compaction did not complete';
  const parts = ['Context compacted'];
  if (trigger) parts.push(trigger);
  if (preTokens != null && postTokens != null) parts.push(`${fmt(preTokens)} → ${fmt(postTokens)} tokens`);
  else if (preTokens != null) parts.push(`${fmt(preTokens)} tokens`);
  return parts.join(' · ');
}

// The replayed `/compact` command wrapper and the local-command output line the
// CLI writes after a compaction. Used only to order and absorb echoes around
// the bubble — the `/compact` bubble itself is never altered.
export const isCompactCommandText = (t) => /^<command-name>\/compact<\/command-name>/.test(t);
export const isLocalCommandStdoutText = (t) => /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(t.trim());

export class CompactionBlock {
  constructor() {
    this.state = 'running';
    this.meta = {};
    this.error = null;
    this.badge = el('span', { class: 'compaction-badge', title: 'Context compaction' }, '🗜');
    this.label = el('span', { class: 'compaction-label' });
    this.header = el('div', { class: 'block compaction plain' }, this.badge, this.label);
    this.body = el('div', { class: 'blocks' }, this.header);
    this.node = el('div', { class: 'msg compaction' }, this.body);
    this._renderLabel();
  }

  _renderLabel() {
    this.label.textContent = compactionLabel({ state: this.state, error: this.error, ...this.meta });
  }

  fill({ trigger = null, preTokens = null, postTokens = null }) {
    this.state = 'done';
    this.meta = { trigger, preTokens, postTokens };
    this._renderLabel();
  }

  markFailed(error) {
    this.state = 'failed';
    this.error = error ?? null;
    this._renderLabel();
  }

  // Turns the header into a collapsed <details> holding the summary.
  setSummary(text) {
    const details = el('details', { class: 'block compaction' }, el('summary', {}, this.badge, this.label));
    mountFoldedText(details, text);
    this.body.replaceChild(details, this.header);
    this.header = details;
  }
}
