/// <reference types="node" />
// Narration — a thinking block with text straight after a redacted one,
// flagged `narration: true` on its thinking_delta events by the server — shows
// in the message flow outside the action group, live and on reload alike, and
// stays out of copy and read-aloud. Fixtures are the real captures under
// tests/fixtures/narration/, fed through the server's own parser and
// transcript replay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireEvent } from '@testing-library/react';
import { ConversationModel, type AssistantNode, type NarrationNode, type ThinkingNode } from './model';
import { assistants, feedFrames, groupsOf, readJsonl, serverModules, shape } from './testkit';
import { flush, renderModel } from './renderModel';

const NARRATION_TEXT = "This is fixable: I'll have the server save the instruction text (not the cut-off frame) as the session's first-prompt preview when the first prompt is a forward, update `readablePrompt`/`promptPreview` to show its first line (falling back to \"Forwarded worker output\" when missing), and adjust the related tests and docs—also noting that generic instruction openers should be replaced with role lines so titles stay meaningful.\n\n";

let S: Awaited<ReturnType<typeof serverModules>>;
let rootDir: string;
let prevRoot: string | undefined;
beforeAll(async () => {
  S = await serverModules();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-narration-'));
  prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
  else process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
  await fs.rm(rootDir, { recursive: true, force: true });
});

function live(name: string, opts: ConstructorParameters<typeof ConversationModel>[0] = {}) {
  const m = new ConversationModel(opts);
  feedFrames(m, new S.Parser(), readJsonl(`narration/${name}.stdout.jsonl`));
  return m;
}

async function replay(name: string) {
  const cwd = `/tmp/narration-${name}`;
  const sid = `sess-narration-${name}`;
  const file = path.join(rootDir, S.encodeCwd(cwd), `${sid}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = readJsonl(`narration/${name}.transcript.jsonl`);
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const result = await S.loadPersistedTranscript({ place: S.localPlace(cwd), sessionId: sid });
  const m = new ConversationModel();
  m.applyEvents(result.lines.flatMap((l: any) => l.events));
  return m;
}

const narrations = (w: AssistantNode) => w.children.filter((c): c is NarrationNode => c.type === 'narration');
const groupThinking = (w: AssistantNode) =>
  groupsOf(w).flatMap((g) => g.children.filter((c): c is ThinkingNode => c.type === 'thinking'));
/** The bubble's children as types, a group as the types inside it; usage lines left out (replay has none). */
const outline = (w: AssistantNode) => w.children.filter((c) => c.type !== 'call_usage')
  .map((c) => (c.type === 'group' ? c.children.filter((g) => g.type !== 'call_usage').map((g) => g.type) : c.type));

describe('narration in the transcript model', () => {
  for (const [label, build] of [['live', async () => live('claude-narration')], ['reload', () => replay('claude-narration')]] as const) {
    it(`${label}: the narration is a direct child of the bubble, outside every group, between the thinking's group and the tool's`, async () => {
      // Invariant: a narration block leaves the action group — it is shown in the flow, and like prose it closes the open group.
      const m = await build();
      const [w] = assistants(m);
      const [note] = narrations(w);
      expect(note).toBeDefined();
      expect(note.buffer).toBe(NARRATION_TEXT);
      expect(note.finalized).toBe(true);
      expect(note.parent === w).toBe(true);
      expect(outline(w)).toEqual([['thinking'], 'narration', ['tool']]);
      const thinks = groupThinking(w);
      expect(thinks.map((t) => [t.redacted, t.buffer])).toEqual([[true, '']]);
      // No group is left empty by the conversion.
      expect(groupsOf(w).every((g) => g.children.length > 0)).toBe(true);
    });
  }

  it('live and reload build the same items and the same bubble', async () => {
    // Invariant: a reload shows narration exactly as the live stream did.
    const l = live('claude-narration');
    const r = await replay('claude-narration');
    expect(shape(r)).toEqual(shape(l));
    expect(outline(assistants(r)[0])).toEqual(outline(assistants(l)[0]));
  });

  for (const [label, build] of [['live', async () => live('deepseek-plain')], ['reload', () => replay('deepseek-plain')]] as const) {
    it(`${label}: readable thinking from a never-redacted model stays grouped thinking`, async () => {
      // Invariant: only the rule's shape converts; plain thinking renders as today.
      const m = await build();
      const ws = assistants(m);
      expect(ws.flatMap(narrations)).toEqual([]);
      const thinks = ws.flatMap(groupThinking);
      expect(thinks.length).toBe(2);
      expect(thinks.every((t) => !t.redacted && t.buffer.length > 0)).toBe(true);
    });
  }

  it('a flagged delta with no thinking_start (ring head trimmed) still becomes a narration node', () => {
    // Invariant: the flag alone decides; a missing start does not drop the note into a group.
    const m = new ConversationModel();
    m.apply({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 1, text: 'Checking the parser next.', narration: true, _seq: 1 });
    m.apply({ kind: 'thinking_end', msgId: 'm1', blockIdx: 1, _seq: 2 });
    const [w] = assistants(m);
    expect(outline(w)).toEqual(['narration']);
    expect(narrations(w)[0].buffer).toBe('Checking the parser next.');
    expect(narrations(w)[0].finalized).toBe(true);
  });

  it('narration is neither copied nor handed to read-aloud', () => {
    // Invariant: narration is a progress note, not the assistant's answer.
    const spoken: string[] = [];
    const m = live('claude-narration', { onAssistantText: (n) => spoken.push(n.buffer) });
    const [w] = assistants(m);
    expect(ConversationModel.assistantCopyText(w)).not.toContain('This is fixable');
    expect(spoken).toEqual([]);
  });
});

describe('narration rendering', () => {
  it('shows the note without opening any group; the redacted thinking stays inside its group', async () => {
    // Invariant: narration is visible in the flow by default, and the redacted block still renders where it did.
    const { root } = renderModel(live('claude-narration'));
    await flush();
    const note = root.querySelector('[data-narration]');
    expect(note?.textContent).toContain('This is fixable');
    expect(note?.closest('[data-group-trigger]')).toBeNull();
    for (const trigger of root.querySelectorAll('[data-group-trigger]')) {
      if (trigger.getAttribute('data-state') === 'closed') fireEvent.click(trigger);
    }
    await flush();
    expect(root.querySelectorAll('[data-thinking="redacted"]').length).toBe(1);
  });
});
