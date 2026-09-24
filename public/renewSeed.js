// Shared (server + client) format for the `renew_session` reseed — the first
// user turn injected into a session after its context was cleared and
// rotated. `src/sessionRenew.ts` builds it with `buildRenewSeed`; this module
// also owns the fence strings and section-heading titles so the client can
// parse the very same text back out and render it as a folded bubble (see
// `public/foldedText.js`'s `renderRenewSeedInto`, mirroring how
// `public/wakeCallback.js` is shared with `src/idleSubscriptions.ts`). Being
// in-band means a seed already in history is recognised too — no wire or
// protocol change, no marker leaking into `firstPrompt` or sidebar previews.
//
// DOM-free: the server imports this module directly, so it must never pull in
// anything from the browser.

export const RENEW_SEED_PREAMBLE =
  'Your context was just renewed (cleared) at your own request via renew_session. '
  + 'The section below is the handoff summary you wrote for yourself before the clear — '
  + 'treat it as your working memory and continue from it.';

export const HANDOFF_FENCE = '--- HANDOFF SUMMARY ---';
export const FOLLOWUP_FENCE = '--- YOUR CONDUCTOR\'S FOLLOW-UP DIRECTIVE ---';

// The exact first line buildStateBlock (src/sessionRenew.ts) writes.
export const MECHANICAL_STATE_HEADER =
  '--- MECHANICAL STATE (server-generated at renewal; safety net — if this '
  + 'disagrees with your summary above, this list wins for EXISTENCE, the '
  + 'summary wins for INTENT) ---';

// The single home of the summary template's section-heading titles: the
// server's RENEW_SUMMARY_TEMPLATE interpolates them into its `## <title>`
// instructions, and the client's splitSummarySections recognises them back.
export const RENEW_SUMMARY_SECTIONS = Object.freeze({
  roster: 'Live work roster',
  completed: 'Completed work index',
  userContext: 'User context',
});

// Compose the reseed text. Each part sits under its own fence: the
// self-authored summary, then — when a conductor requested this renewal with
// a `followUp` — its post-renewal directive, then the mechanical state block
// (built fresh at reseed time). Output bytes are load-bearing: this text is
// the worker's own first turn.
export function buildRenewSeed({ summary, followUp = null, stateBlock = null } = {}) {
  const parts = [];
  parts.push(
    RENEW_SEED_PREAMBLE + '\n\n' + HANDOFF_FENCE + '\n' + String(summary ?? '').trim(),
  );
  if (followUp && String(followUp).trim()) {
    parts.push(FOLLOWUP_FENCE + '\n' + String(followUp).trim());
  }
  if (stateBlock && String(stateBlock).trim()) {
    parts.push(String(stateBlock).trim());
  }
  return parts.join('\n\n');
}

// Parse a user-echo text into its renew-seed parts, or null when it isn't
// one. The mechanical state block is always the LAST part buildRenewSeed
// appends, so its header is found via lastIndexOf and cut off the tail
// first; the follow-up fence — only searched for when a real state block was
// found, see the followUp comment below — is then found the same way (last
// occurrence, so an earlier quote in the summary loses to a real one after
// it) in what remains, leaving the summary as whatever is left.
export function parseRenewSeed(text) {
  const prefix = RENEW_SEED_PREAMBLE + '\n\n' + HANDOFF_FENCE + '\n';
  if (typeof text !== 'string' || !text.startsWith(prefix)) return null;
  let rest = text.slice(prefix.length);

  let state = null;
  const stateMarker = '\n\n' + MECHANICAL_STATE_HEADER;
  const i = rest.lastIndexOf(stateMarker);
  if (i >= 0) {
    const afterHeader = rest.slice(i + stateMarker.length);
    state = afterHeader.startsWith('\n') ? afterHeader.slice(1) : afterHeader;
    rest = rest.slice(0, i);
  }

  // A followUp is searched for only when a real state block was found. This
  // guards exactly one shape, the state-less one: without a state block,
  // ANY occurrence of the fence in the summary — even mid-summary — is
  // indistinguishable from a real one, since buildRenewSeed's output is
  // byte-identical either way (it trims and joins both the same way), and
  // that shape never occurs in production (buildStateBlock is always called
  // before buildRenewSeed). With a state block present the same ambiguity
  // still exists for a lone occurrence — this only takes the LAST one, it
  // performs no adjacency check — so a mid-summary quote there is still
  // split off as if real; that residual case is accepted, not fixable from
  // the text alone, since every position a match could occur at is equally
  // consistent with being what buildRenewSeed actually built.
  let followUp = null;
  if (i >= 0) {
    const followUpMarker = '\n\n' + FOLLOWUP_FENCE + '\n';
    const j = rest.lastIndexOf(followUpMarker);
    if (j >= 0) {
      followUp = rest.slice(j + followUpMarker.length);
      rest = rest.slice(0, j);
    }
  }

  return { summary: rest, followUp, state };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHeadingRegex() {
  const alt = Object.values(RENEW_SUMMARY_SECTIONS).map(escapeRegExp).join('|');
  return new RegExp(
    '^\\s{0,3}(?:#{1,6}\\s+)?(?:\\*\\*|__)?\\s*(?:\\(\\d+\\)|\\d+[.)])?\\s*(?:\\*\\*|__)?\\s*'
    + `(${alt})` + '\\s*:?\\s*(?:\\*\\*|__)?\\s*:?\\s*$',
    'i',
  );
}

const FENCE_LINE = /^\s{0,3}(```|~~~)/;

// Split a summary into labelled sections. A heading is a whole line matching
// one of RENEW_SUMMARY_SECTIONS' titles (accepting `##`, bold, numbered and
// parenthesised variants — see buildHeadingRegex); a title mid-sentence or
// followed by prose on the same line stays plain body text. Lines inside a
// fenced code block are never read as headings. No heading anywhere falls
// back to one untitled section equal to the whole input; leading text before
// the first heading becomes its own untitled section, but only if non-blank.
// Every non-heading line of the input ends up in exactly one section's body.
export function splitSummarySections(summary) {
  const text = String(summary ?? '');
  const headingRe = buildHeadingRegex();
  const canonicalByLower = new Map(
    Object.values(RENEW_SUMMARY_SECTIONS).map((t) => [t.toLowerCase(), t]),
  );

  let inFence = false;
  let sawHeading = false;
  const raw = [];
  let current = { title: null, lines: [] };
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    let matched = null;
    if (!inFence) {
      const m = headingRe.exec(line);
      if (m) matched = canonicalByLower.get(m[1].toLowerCase()) ?? m[1];
    }
    if (matched) {
      sawHeading = true;
      raw.push(current);
      current = { title: matched, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  raw.push(current);

  if (!sawHeading) return [{ title: null, body: text }];

  const sections = [];
  for (const sec of raw) {
    const ls = sec.lines;
    let start = 0;
    let end = ls.length;
    while (start < end && ls[start].trim() === '') start++;
    while (end > start && ls[end - 1].trim() === '') end--;
    const body = ls.slice(start, end).join('\n');
    if (sec.title !== null || body.length) sections.push({ title: sec.title, body });
  }
  return sections;
}
