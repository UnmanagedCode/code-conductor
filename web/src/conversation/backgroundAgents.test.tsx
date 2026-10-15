/// <reference types="node" />
// Background agents and the unprompted turns they start, read off a real
// three-background-agent session (tests/fixtures/bg-agents-reinvoke.*): a first
// prompt runs three foreground Agents in parallel; a second runs three
// `run_in_background` Agents and ends its turn, and the CLI then runs one
// unprompted turn per agent's notification. The stdout fixture is every frame of
// that run in order, with the two prompts (which reach the stream from stdin)
// spliced in where they were sent.
import { beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationModel, type AssistantNode, type RootItem } from './model';
import { FIXTURES, apply, readJsonl, serverModules } from './testkit';
import { flush, renderModel } from './renderModel';
import type { UiEvent, UiEventOf } from '@shared/uiEvent';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

const FRAMES = 'bg-agents-reinvoke.stdout.jsonl';
const TRANSCRIPT = 'bg-agents-reinvoke.transcript.jsonl';
const SUBAGENTS = 'bg-agents-reinvoke.subagents';
const CWD = '/workspace/project';
const SID = '3b7c9a2e-5d14-4f8b-9e61-0a2c4d6e8f10';
// Background agent 1's task id: its sub-agent file is agent-<task id>.jsonl.
const BG1_TASK = 'add5b435710fcc1aa';
// The three background Agents, by the order the model launched them.
const BG = ['toolu_01MBEWr1rB6iD4GGqk7fUp7g', 'toolu_01YPwsVaS2QZAwD2Gity8ueh', 'toolu_01Eat1wLEwMh69bFp5ng99Lj'];
const FG = ['toolu_01Hkdt6tXL6P9FvcM9XV4R5b', 'toolu_018jxCJ5xCoCqLjtcqALSefa', 'toolu_01MEdq7z89WX2fQiXuXetFyY'];

const liveEvents = (): UiEvent[] => {
  const parser = new S.Parser();
  return readJsonl(FRAMES).flatMap((f) => parser.handleObject(f));
};
function liveModel() {
  const m = new ConversationModel();
  for (const ev of liveEvents()) apply(m, ev);
  return m;
}

/**
 * The session's events as a restart replays them: the transcript plus its sub-agent files under a
 * temp projects root, every sub-agent file but those `omit` names.
 */
async function replayEvents({ omit = [] as string[] } = {}): Promise<UiEvent[]> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bga-'));
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = home;
  try {
    const dir = path.join(home, S.encodeCwd(CWD));
    await fs.mkdir(path.join(dir, SID, 'subagents'), { recursive: true });
    await fs.copyFile(path.join(FIXTURES, TRANSCRIPT), path.join(dir, `${SID}.jsonl`));
    for (const name of await fs.readdir(path.join(FIXTURES, SUBAGENTS))) {
      if (omit.some((id) => name.includes(id))) continue;
      await fs.copyFile(path.join(FIXTURES, SUBAGENTS, name), path.join(dir, SID, 'subagents', name));
    }
    const result = await S.loadPersistedTranscript({ place: S.localPlace(CWD), sessionId: SID, seqHint: 0 });
    return result.lines.flatMap((l: any) => l.events);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
}
function modelOf(events: UiEvent[]) {
  const m = new ConversationModel();
  for (const ev of events) apply(m, ev);
  return m;
}

/** The root items after the `n`th user bubble (1-based), up to the next one. */
function afterUser(m: ConversationModel, n: number): RootItem[] {
  const at: number[] = [];
  m.items.forEach((it, i) => { if (it.type === 'user') at.push(i); });
  return m.items.slice(at[n - 1] + 1, at[n] ?? m.items.length);
}
const texts = (w: AssistantNode) => w.children.flatMap((c) => (c.type === 'text' ? [c.buffer] : []));
/** Each bubble's text blocks, cut to the length of the expected prefix they are matched against. */
const textPartition = (items: RootItem[], expected: string[][]) =>
  items.filter((i): i is AssistantNode => i.type === 'assistant')
    .map((w, b) => texts(w).map((t, k) => t.slice(0, expected[b]?.[k]?.length ?? t.length)));
const agentCards = (w: AssistantNode) =>
  w.children.flatMap((c) => (c.type === 'group' ? c.children : [])).filter((c) => c.type === 'tool' && c.name === 'Agent');
const rootLabels = (items: RootItem[]) => items.map((i) => {
  if (i.type !== 'system') return i.type;
  return i.ev.subtype === 'task_notification' ? `tn ${i.ev.toolUseId}` : i.ev.subtype;
});

const TURN2_ON = [["I've launched"], ['The first agent'], ['The third agent'], ['All three background']];
const LATER_TURNS = ['The first agent has finished', 'The third agent has finished', 'All three background agents have finished'];

describe('each turn owns its bubble and its turn-end row', () => {
  it('the turn that launched the agents and each unprompted turn after it get their own bubble (T1)', () => {
    const m = liveModel();
    const turn2 = afterUser(m, 2);
    const launch = turn2.find((i): i is AssistantNode => i.type === 'assistant')!;
    expect(agentCards(launch).map((t) => (t as any).toolUseId)).toEqual(BG);
    expect(agentCards(launch).every((t) => (t as any).sub)).toBe(true);
    expect(m.items.filter((i) => i.type === 'turn_end')).toHaveLength(5);
    expect(textPartition(turn2, TURN2_ON)).toEqual(TURN2_ON);
  });

  it('every bubble is followed by its own turn-end row, and a notification at a turn\'s tail goes below that row (T2)', () => {
    const m = liveModel();
    expect(rootLabels(afterUser(m, 2))).toEqual([
      'init', 'assistant', 'turn_end', `tn ${BG[0]}`,
      'init', 'assistant', 'turn_end', `tn ${BG[2]}`,
      'init', `tn ${BG[1]}`, 'assistant', 'turn_end',
      'init', 'assistant', 'turn_end',
    ]);
  });

  it('the launching turn\'s "Done" row renders right under its bubble (T3)', async () => {
    const r = renderModel(liveModel());
    await flush();
    const bubble = [...r.root.querySelectorAll('[data-item="assistant"]')].find((n) => n.textContent!.includes("I've launched"))!;
    const next = bubble.nextElementSibling!;
    expect(next.getAttribute('data-item')).toBe('turn-end');
    expect(next.textContent).toContain('4.4s');
    for (const later of LATER_TURNS) expect(bubble.textContent).not.toContain(later);
    for (const later of LATER_TURNS) {
      const own = [...r.root.querySelectorAll('[data-item="assistant"]')].find((n) => n.textContent!.includes(later))!;
      expect(own.nextElementSibling?.getAttribute('data-item')).toBe('turn-end');
    }
  });

  it('a turn\'s parallel foreground agents and its closing prose share one bubble (T4)', () => {
    const m = liveModel();
    const turn1 = afterUser(m, 1);
    expect(rootLabels(turn1)).toEqual(['init', 'assistant', 'turn_end']);
    const w = turn1[1] as AssistantNode;
    expect(agentCards(w).map((t) => (t as any).toolUseId)).toEqual(FG);
    expect(texts(w).map((t) => t.slice(0, 22))).toEqual(['All three agents liste']);
  });
});

const notification = (evs: UiEvent[], toolUseId: string) =>
  evs.find((e): e is UiEventOf<'system'> => e.kind === 'system' && e.subtype === 'task_notification' && e.toolUseId === toolUseId)!;
/** The task-notification row of the agent whose headline names `n`. */
const rowOf = (root: HTMLElement, n: number) =>
  [...root.querySelectorAll('[data-subtype="task_notification"]')].find((r) => r.querySelector('[data-headline]')!.textContent === `List project contents (agent ${n}) · completed`)!;
/** The last text block of the agent's sub-agent transcript. */
function lastSubText(m: ConversationModel, toolUseId: string) {
  const sub = m.toolBlocks.get(toolUseId)!.sub!;
  const bubbles = sub.items.filter((i): i is AssistantNode => i.type === 'assistant');
  return texts(bubbles[bubbles.length - 1]).at(-1);
}

describe('a background agent\'s report lives only in its card', () => {
  it('live, each agent\'s notification row is its headline alone; its card already holds the report (T5)', async () => {
    const evs = liveEvents();
    const m = modelOf(evs);
    for (const id of BG) expect(lastSubText(m, id)).toBe(notification(evs, id).data!.summary);
    const r = renderModel(m);
    await flush();
    for (const [n, id] of [[1, BG[0]], [2, BG[1]], [3, BG[2]]] as const) {
      const row = rowOf(r.root, n);
      expect(row.querySelector('[data-fold-body]')).toBeNull();
      expect(row.textContent).not.toContain(notification(evs, id).data!.summary);
    }
  });

  it('after a restart, each agent whose sub-agent transcript loaded gets a headline-only row (T6)', async () => {
    const evs = await replayEvents();
    const r = renderModel(modelOf(evs));
    await flush();
    for (const n of [1, 2, 3]) {
      expect(rowOf(r.root, n)).toBeTruthy();
      expect(rowOf(r.root, n).querySelector('[data-fold-body]')).toBeNull();
    }
  });

  it('sub-agent transcript unavailable: the agent\'s row keeps its report in the fold, the only place it shows (T6)', async () => {
    const evs = await replayEvents({ omit: [BG1_TASK] });
    const m = modelOf(evs);
    expect(m.toolBlocks.get(BG[0])!.sub).toBeNull();
    const r = renderModel(m);
    await flush();
    expect(rowOf(r.root, 1).querySelector('[data-fold-body]')!.textContent).toContain(notification(evs, BG[0]).data!.summary);
    for (const n of [2, 3]) expect(rowOf(r.root, n).querySelector('[data-fold-body]')).toBeNull();
  });
});
