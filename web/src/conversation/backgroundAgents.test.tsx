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
import { FIXTURES, apply, groupsOf, readJsonl, serverModules, tool, toolResult, turnEnd } from './testkit';
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
/** The replay's events, one list per transcript line (no sub-agent file is dropped). */
async function replayLines(): Promise<UiEvent[][]> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bga-'));
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = home;
  try {
    const dir = path.join(home, S.encodeCwd(CWD));
    await fs.mkdir(path.join(dir, SID), { recursive: true });
    await fs.copyFile(path.join(FIXTURES, TRANSCRIPT), path.join(dir, `${SID}.jsonl`));
    await fs.cp(path.join(FIXTURES, SUBAGENTS), path.join(dir, SID, 'subagents'), { recursive: true });
    const result = await S.loadPersistedTranscript({ place: S.localPlace(CWD), sessionId: SID, seqHint: 0 });
    return result.lines.map((l: any) => l.events);
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

/** The action groups of a sub-agent's transcript, by the Agent card hosting it. */
const subGroups = (m: ConversationModel, agent: string) =>
  m.toolBlocks.get(agent)!.sub!.items.filter((i): i is AssistantNode => i.type === 'assistant').flatMap(groupsOf);
const kinds = (g: ReturnType<typeof groupsOf>[number]) => g.children.map((c) => (c.type === 'tool' ? c.name : c.type));

describe('a backgrounded agent\'s run spans outer run-enders', () => {
  it('live, a background agent\'s machinery run stays one group across the outer turn\'s end (T7)', () => {
    const frames = readJsonl(FRAMES);
    const turn2End = frames.map((f, i) => (f.type === 'result' ? i : -1)).filter((i) => i >= 0)[1];
    for (const id of [BG[0], BG[2]]) {
      const at = frames.map((f, i) => (f.parent_tool_use_id === id ? i : -1)).filter((i) => i >= 0);
      expect(at.some((i) => i < turn2End) && at.some((i) => i > turn2End)).toBe(true);
    }
    const m = liveModel();
    for (const id of [BG[0], BG[2]]) {
      expect(subGroups(m, id).map(kinds)).toEqual([['thinking', 'Bash', 'thinking']]);
      expect(subGroups(m, id)[0].open).toBe(false);
    }
  });

  const AGENTS = ['agentA', 'agentB', 'agentC'];
  let n = 0;
  const child = (agent: string, block: Record<string, unknown>): UiEvent =>
    ({ kind: 'assistant_message', msgId: `c${++n}`, message: { content: [block] }, parentToolUseId: agent }) as UiEvent;
  const childThinking = (agent: string) => child(agent, { type: 'thinking', thinking: 'pondering' });
  const childBash = (agent: string) => child(agent, { type: 'tool_use', id: `${agent}-bash`, name: 'Bash', input: { command: 'ls' } });
  /** Three agents launched in one turn, each mid-run when the turn ends and when the next prompt arrives. */
  function interleaved(backgrounded: boolean) {
    const m = launched(backgrounded);
    apply(m, turnEnd());
    return m;
  }
  /** The three agents launched, each with a thinking and a Bash still unanswered, the outer turn still going. */
  function launched(backgrounded: boolean, { started = true } = {}) {
    const m = new ConversationModel();
    const evs: UiEvent[] = [
      ...AGENTS.flatMap((a, i) => tool('m1', i, a, 'Agent', { result: null, input: { run_in_background: backgrounded } })),
      ...(started ? AGENTS.map((a, i) => taskStarted(a, i, backgrounded)) : []),
      ...AGENTS.map((a) => toolResult({ toolUseId: a, content: 'Async agent launched successfully.' })),
      ...AGENTS.map(childThinking),
      ...AGENTS.map(childBash),
    ];
    for (const ev of evs) apply(m, ev);
    return m;
  }
  const taskStarted = (a: string, i: number, backgrounded: boolean): UiEvent =>
    ({ kind: 'system', subtype: 'task_started', data: { task_id: `task${i}`, tool_use_id: a, is_backgrounded: backgrounded } });
  /** A notified notification, shaped as the parser builds an Agent's. */
  const ended = (a: string, status: string, summary: string): UiEvent => ({
    kind: 'system', subtype: 'task_notification', toolUseId: a,
    data: { task_id: `task-${a}`, status, output_file: '', name: `probe ${a}`, exitCode: null, summary, notified: true },
  });
  const FAILED = 'Agent "probe agentA" failed: the API returned an overloaded error';
  function onwards(m: ConversationModel) {
    for (const a of AGENTS) apply(m, toolResult({ toolUseId: `${a}-bash`, content: 'ok', parentToolUseId: a }));
    for (const a of AGENTS) apply(m, childThinking(a));
    apply(m, { kind: 'user_echo', text: 'next prompt' });
    for (const a of AGENTS) apply(m, childThinking(a));
  }

  for (const subtype of ['exit', 'crashed']) {
    it(`background agents' runs stay open across a turn end and a new prompt; a process ${subtype} folds them (T8)`, () => {
      const m = interleaved(true);
      onwards(m);
      for (const a of AGENTS) {
        expect(subGroups(m, a).map(kinds)).toEqual([['thinking', 'Bash', 'thinking', 'thinking']]);
        expect(subGroups(m, a)[0].open).toBe(true);
      }
      apply(m, { kind: 'system', subtype });
      for (const a of AGENTS) expect(subGroups(m, a)[0].open).toBe(false);
    });
  }

  it('a failed background agent stopped mid-run: its notification folds its group, and the row keeps the reason in its fold (T13)', async () => {
    const m = launched(true);
    apply(m, ended('agentA', 'failed', FAILED));
    expect(subGroups(m, 'agentA').map((g) => g.open)).toEqual([false]);
    for (const a of ['agentB', 'agentC']) expect(subGroups(m, a).map((g) => g.open)).toEqual([true]);
    const r = renderModel(m);
    await flush();
    const row = r.root.querySelector('[data-subtype="task_notification"]')!;
    expect(row.querySelector('[data-headline]')!.textContent).toBe('probe agentA · failed');
    expect(row.querySelector('[data-fold-body]')).not.toBeNull();
    expect(row.querySelector('[data-fold-body]')!.textContent).toContain(FAILED);
  });

  it('an agent whose card ends on prose other than its report keeps the report in the row\'s fold (T14)', async () => {
    const m = launched(true);
    apply(m, toolResult({ toolUseId: 'agentA-bash', content: 'ok', parentToolUseId: 'agentA' }));
    apply(m, child('agentA', { type: 'text', text: 'Notes so far: two entries listed.' }));
    apply(m, ended('agentA', 'completed', 'Final report: README.md, src/'));
    const r = renderModel(m);
    await flush();
    const row = r.root.querySelector('[data-subtype="task_notification"]')!;
    expect(row.querySelector('[data-headline]')!.textContent).toBe('probe agentA · completed');
    expect(row.querySelector('[data-fold-body]')).not.toBeNull();
    expect(row.querySelector('[data-fold-body]')!.textContent).toContain('Final report: README.md, src/');
  });

  it('once its task has ended, a later run of the same agent folds at the outer turn\'s end again (T15)', () => {
    const m = launched(true);
    apply(m, ended('agentA', 'completed', 'done'));
    apply(m, childThinking('agentA'));
    expect(subGroups(m, 'agentA').at(-1)!.open).toBe(true);
    apply(m, turnEnd());
    expect(subGroups(m, 'agentA').map((g) => g.open)).toEqual([false, false]);
  });

  it('a notification that arrives before its task_started ends the task for good (T16)', () => {
    const m = launched(true, { started: false });
    apply(m, ended('agentA', 'completed', 'done'));
    apply(m, taskStarted('agentA', 0, true));
    apply(m, childThinking('agentA'));
    apply(m, turnEnd());
    expect(subGroups(m, 'agentA').map((g) => g.open)).toEqual([false, false]);
  });

  it('a foreground agent\'s run folds at the outer turn\'s end, its notification arriving after (T9)', () => {
    const m = interleaved(false);
    for (const a of AGENTS) expect(subGroups(m, a).map((g) => g.open)).toEqual([false]);
    for (const a of AGENTS) apply(m, { kind: 'system', subtype: 'task_notification', toolUseId: a, data: { status: 'completed', notified: false } });
    for (const a of AGENTS) expect(subGroups(m, a).map((g) => g.open)).toEqual([false]);
  });
});

/** Each user section's bubbles, as their full text blocks. */
const sections = (m: ConversationModel) => [1, 2].map((n) =>
  afterUser(m, n).filter((i): i is AssistantNode => i.type === 'assistant').map(texts));

describe('a restart replays the same turns', () => {
  it('the replayed session gives the launching turn and each unprompted turn their own bubble (T10)', async () => {
    const evs = await replayEvents();
    expect(evs.filter((e): e is UiEventOf<'system'> => e.kind === 'system' && e.subtype === 'task_notification').map((e) => e.toolUseId))
      .toEqual([BG[0], BG[2], BG[1]]);
    expect(textPartition(afterUser(modelOf(evs), 2), TURN2_ON)).toEqual(TURN2_ON);
  });

  it('a reload shows the same bubbles, with the same prose, as the live stream did (T11)', async () => {
    const live = sections(liveModel());
    expect(live[1]).toHaveLength(4);
    expect(sections(modelOf(await replayEvents()))).toEqual(live);
  });

  it('a lazy page ending on an unprompted turn\'s eve does not merge into that turn\'s bubble (T12)', async () => {
    const lines = await replayLines();
    const jsonl = readJsonl(TRANSCRIPT);
    expect(lines).toHaveLength(jsonl.length);
    // The second delivery line starts the turn the live chunk opens with.
    const delivery = jsonl.map((l, i) => (l.turnOrigin === 'task_notification' ? i : -1)).filter((i) => i >= 0)[1];
    const page = lines.slice(0, delivery).flat();
    const tail = lines.slice(delivery).flat();
    const live = new ConversationModel();
    for (const ev of tail) apply(live, ev);
    expect(live.leadingAssistantWrap).toBeNull();
    live.prependPage(live.renderPage(page, null, null), live.leadingAssistantWrap);
    expect(textPartition(afterUser(live, 2), TURN2_ON)).toEqual(TURN2_ON);
  });
});
