// Renders a playbook definition as the conductor-prompt section for the
// SELECTED DEFAULT playbook (Settings → Conductor conventions → Default
// playbook). Composed into the role prompt by src/conductorConventions.ts.
//
// GENERATED, NEVER HAND-AUTHORED. That is the whole point: the JSON owns the
// structure and the policy, each stage's `description` owns the conductor's move
// at that stage, and this file owns the one rendering of both. A hand-maintained
// copy of the graph in prose is the duplication this surface exists to kill —
// don't reintroduce it here by paraphrasing what the definition says.
//
// `describe_playbook` remains the live authority; this is a reminder that saves
// the conductor a round-trip to know its baseline.
//
// Authored text (stage/transition `description`) is passed through VERBATIM —
// never truncated, reflowed or summarised. One home for that text is the
// definition; a renderer that edited it would become a second one.

import { type Playbook, type Stage, type ToolPolicy, isSpawnable } from './playbooks.ts';

// ENUMERATION SCOPE. A per-stage policy list reads as a complete fence unless
// its limits are stated before it — and the strongest bar a reader would infer
// cannot exist: merge_worktree/delete_worktree declare no `sessionId`, so they
// are ungovernable by construction and a playbook naming them is rejected at
// load. Playbook policy gates WHO WORKS, never WHAT LANDS.
//
// The closure half is the other inference to block: the per-stage lists are
// DELTAS off a default, not allow-lists. Stated once here rather than annotated
// onto every stage.
//
// Neither line restates the land-gating rule itself (that lives in
// conventions/conductor/canonical-workflow.md) — they bound this rendering.
const SCOPE_LINE =
  'Policy governs only calls that name a worker, plus `spawn_instance` — it never gates what lands.';
const CLOSURE_LINE =
  'Unlisted tools are allowed; `spawn_instance` is denied in any stage that does not name it.';

export function renderPlaybookConvention(pb: Playbook): string {
  const lines: string[] = [
    `## Default playbook — \`${pb.id}\``,
    '',
    pb.description,
    '',
    `Generated from the definition; \`describe_playbook({id: '${pb.id}'})\` is the live authority.`,
    `Enter at: ${pb.entryStages.map(s => `\`${s}\``).join(', ') || '(no entry stage)'}. ${SCOPE_LINE}`,
    CLOSURE_LINE,
    '',
  ];

  for (const [name, stage] of Object.entries(pb.stages)) {
    const flags = stageFlags(stage);
    const head = `- **${name}**${flags ? ` (${flags})` : ''}`;
    // The authored description, verbatim. Absent unless authored, so the stage
    // renders as a bare header rather than with a dangling em dash.
    lines.push(stage.description === undefined ? head : `${head} — ${stage.description}`);
    for (const need of stage.needs) {
      lines.push(`  - needs: a worker ${need.at === 'ever' ? 'that has passed through' : 'currently in'} \`${need.stage}\``);
    }
    const policy = renderTools(stage.tools);
    if (policy) lines.push(`  - policy: ${policy}`);
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

// Only the non-default facts: `workers: "one"` and non-spawnability are the
// defaults, so naming them would be noise in every stage of every playbook.
function stageFlags(stage: Stage): string {
  const flags: string[] = [];
  if (isSpawnable(stage)) flags.push('spawnable');
  if (stage.workers === 'many') flags.push('many workers');
  return flags.join(', ');
}

// Sorted by tool name so the rendering is a function of the definition's
// content, not of its key order.
function renderTools(tools: Record<string, ToolPolicy>): string {
  const names = Object.keys(tools).sort();
  if (names.length === 0) return '';
  return names.map(n => `${n === '*' ? '`*` (all other tools)' : `\`${n}\``} ${renderPolicy(tools[n])}`).join('; ');
}

function renderPolicy(policy: ToolPolicy): string {
  if (typeof policy === 'string') return policy;
  return `require ${Object.entries(policy.require)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`;
}
