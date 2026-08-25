// Renders a playbook definition as the conductor role-doc section for the
// PREFERRED playbook (Settings → Conductor conventions → Preferred playbook).
// Composed into the role prompt by src/conductorConventions.ts.
//
// GENERATED, NEVER HAND-AUTHORED. That is the whole point: the JSON owns the
// structure, each stage's `description` owns the conductor's move at that stage,
// and this file owns the one rendering. A hand-maintained copy of the graph in
// prose is the duplication this surface exists to kill.
//
// WHAT BELONGS HERE — exactly the facts with NO CHANNEL THAT FIRES ON ITS OWN.
// Every fact some refusal or pre-resolved field volunteers unasked stays in the
// payload, where it arrives at point of use and cannot go stale:
//   • `tools` policy   → TOOL_DENIED_IN_STAGE ships it with legalMoves.  OUT.
//   • `needs`          → NEEDS_UNSATISFIED names what to pass.           OUT.
//   • spawnability     → STAGE_NOT_SPAWNABLE, plus list_playbooks'
//                        `spawnableStages` and the `spawnable` describe_playbook
//                        renders per stage.                              OUT.
//   • stage `description` → nothing volunteers it, and it is needed to compose a
//                        brief BEFORE any call is made; a bad brief yields a
//                        soft review, never a refusal.                   IN.
//   • `workers: "many"`  → no refusal until STAGE_AT_CAPACITY has already
//                        fired, and it shapes a fan-out decision made before any
//                        call.                                           IN.
//   • transitions      → a shape error is expensive and non-local, unlike a
//                        refused call.                                   IN.
//
// Authored text is passed through VERBATIM — never truncated, reflowed or
// summarised. One home for that text is the definition; a renderer that edited
// it would become a second.
//
// The sibling renderer is renderPlaybook (src/mcp/readRenderers.ts), which
// answers describe_playbook and renders the WHOLE graph. Do not merge the two:
// the omissions above are the entire reason this one exists, so folding them
// together would push every stage's tools policy into every conductor's prompt.

import { type Playbook, type Stage } from './playbooks.ts';

export function renderPlaybookConvention(pb: Playbook): string {
  // Deliberately NOT repeated here: the playbook's top-level description and a
  // pointer at describe_playbook. The available-playbooks listing sits directly
  // above this section in the same prompt and carries both — echoing them is the
  // duplication this whole surface exists to kill.
  const lines: string[] = [`## Preferred playbook — \`${pb.id}\``, ''];

  for (const [name, stage] of Object.entries(pb.stages)) {
    const flags = stageFlags(stage);
    const head = `- **${name}**${flags ? ` (${flags})` : ''}`;
    lines.push(stage.description === undefined ? head : `${head} — ${stage.description}`);
  }

  if (pb.transitions.length > 0) {
    lines.push('');
    // `via` is derived the same way describe_playbook derives it: an edge with no
    // `on` is driven by send_prompt.
    lines.push(`Transitions: ${pb.transitions.map(t =>
      `\`${t.from} → ${t.to}\` on \`${t.on ?? 'send_prompt'}\``).join('; ')}.`);
    for (const t of pb.transitions) {
      if (t.description !== undefined) lines.push(`- \`${t.from} → ${t.to}\` — ${t.description}`);
    }
  }

  return lines.join('\n');
}

// `workers: "one"` is the default and the common case, so naming it would be
// noise in nearly every stage of every playbook.
function stageFlags(stage: Stage): string {
  return stage.workers === 'many' ? 'many workers' : '';
}
