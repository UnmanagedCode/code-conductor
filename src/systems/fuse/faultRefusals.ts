// THE TWO REFUSALS A FAULT PRODUCES — divergence and over-cap — and nothing
// else.
//
// A SEPARATE MODULE, AND SEPARATE FROM `classifyForTool` BY RULING. The tier
// table's deny surface is STATELESS: it answers from the pins array alone and
// never touches the filesystem, and its four wordings are a closed set with a
// two-directional set-equality proof over `ToolDenyClass`. These two are
// STATEFUL — they exist only because a specific path failed to reconcile
// earlier in this session — so folding them into that switch would both break
// the closed set and invite the next reader to treat a per-path record as a
// tier. A second export in `tierTable.ts` would be that invitation.
//
// THE ORDERING IS ALSO A RULING and lives at the call site (SessionRedirect's
// `#classifyFile`): this surface is consulted only AFTER the tier gate has
// already ALLOWED.
//
// CLAUSE DISCIPLINE, THE SAME FIVE the four tier wordings keep, because the
// failure mode is identical — a model that reads a refusal as file-not-found
// concludes the file is absent instead of using the channel that works:
//   1. cc is named as the actor,
//   2. the act is named as a REFUSAL ("will not"),
//   3. the PATH is named,
//   4. an explicit "NOT the file being absent",
//   5. Bash is named WITH THE MACHINE it answers from.

import type { Fault } from './control.ts';

// A path this session wrote locally and could not land. The recovery channel
// is real and is named twice over: the local copy still reads, and Bash on the
// system can land the change by hand.
export function divergedRefusal(p: string, f: Fault & { kind: 'diverged' }, systemId: string): string {
  return `cc will not write '${p}' in this session: an earlier write to that exact file was `
    + `written locally but could NOT be landed on system '${systemId}' (${f.detail}), so this `
    + `session's copy and the system's have diverged and cc will not overwrite the system's copy `
    + `with a file it cannot reconcile. This is cc refusing to carry the file, NOT the file being `
    + `absent — cc has not looked, and this says nothing about whether it exists. The local copy `
    + `is intact and readable, so the content is not lost. Bash runs ON SYSTEM '${systemId}', not `
    + `on the orchestrator: inspect the system's own '${p}' with \`cat\` there, and land the `
    + `change with \`sed -i\` or a \`>\` redirect on that machine.`;
}

// A file larger than the protocol can carry. NAMES THE CAP, because the number
// is what tells a worker that a range read through Bash is the answer rather
// than a retry.
export function overCapRefusal(p: string, f: Fault & { kind: 'over-cap' }, systemId: string): string {
  return `cc will not carry '${p}' to this session: it is ${f.size} bytes and the system protocol `
    + `carries at most ${f.cap} per file, so cc cannot materialise it and refuses rather than `
    + `serving a truncated copy. This is cc refusing to carry the file, NOT the file being absent `
    + `— the file is there and it is too large. Bash runs ON SYSTEM '${systemId}', not on the `
    + `orchestrator: read it there with \`sed -n\`, \`head\` or \`tail\` on a range, and change it `
    + `with \`sed -i\` or a \`>\` redirect.`;
}

export function refusalFor(fault: Fault, p: string, systemId: string): string {
  return fault.kind === 'diverged'
    ? divergedRefusal(p, fault, systemId)
    : overCapRefusal(p, fault, systemId);
}

// 1 = this fault refuses this tool.
//
// `writes` IS THE COMPLEMENT OF `Read`, DERIVED RATHER THAN TRANSCRIBED. A
// diverged path stays readable on purpose — the preserved bytes are the
// recovery channel the wording points at — and every other file tool mutates.
// Written as "not Read" so a fifth write-capable tool added to FILE_TOOLS is
// refused by default instead of escaping the surface silently.
export function refusesTool(fault: Fault, toolName: string): boolean {
  if (fault.refuses === 'all') return true;
  return toolName !== 'Read';
}
