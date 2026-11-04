// The headless run's two prompt texts. Prepended to the root conductor's first
// prompt and nowhere else: the role doc is shared by every conductor, section
// leads included, so the root's first turn is the only channel that reaches the
// root alone (docs/features.md → Headless mode).

export const HEADLESS_FRAGMENT = `[Headless run] No person is attached to this session, and none will read or answer anything before the run ends.
- Never ask: no AskUserQuestion, no closing question or offer. Where you would ask, choose what best serves the request, state the assumption in one line, and continue.
- Plans and questions from your workers and section leads are yours to decide; nothing escalates past you.
- The run ends once you and every session you own are idle, and your last message is its output: make it the outcome, what changed, and each assumption you made.`;

// The canned answer the runner sends when the root asks through AskUserQuestion.
export const HEADLESS_QUESTION_ANSWER = 'This is a headless session: no person is present and none will answer. Decide yourself — choose what best serves the original request, state the assumption in your final message, and continue.';
