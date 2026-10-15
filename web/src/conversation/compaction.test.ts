import { beforeAll, describe, expect, it } from 'vitest';
import { ConversationModel, type CompactionNode } from './model';
import {
  apply, assistants, compactionLabels, feedFrames, groupsOf, groupText, readJsonl, replayLines, serverModules, shape, systemSubtypes, users,
} from './testkit';
import type { UiEvent } from '@shared/uiEvent';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

const N = (n: number) => n.toLocaleString();
const MANUAL_LABEL = `Context compacted · manual · ${N(27152)} → ${N(2952)} tokens`;
const AUTO_LABEL = `Context compacted · auto · ${N(183658)} → ${N(24338)} tokens`;
const AUTO_PROMPT = 'again, read all wiki pages';
const SUMMARY_PREFIX = 'This session is being continued';

function renderLive() {
  const m = new ConversationModel();
  apply(m, { kind: 'user_echo', text: '/compact', userIndex: 1 });
  feedFrames(m, new S.Parser(), readJsonl('compaction-manual.stdout.jsonl'));
  return m;
}
function renderReload() {
  const m = new ConversationModel();
  replayLines(m, S.replayPersistedLine, readJsonl('compaction-manual.transcript.jsonl'));
  return m;
}
function renderAutoLive() {
  const m = new ConversationModel();
  apply(m, { kind: 'user_echo', text: AUTO_PROMPT, userIndex: 3 });
  feedFrames(m, new S.Parser(), readJsonl('compaction-auto.stdout.jsonl'));
  return m;
}
function renderAutoReload() {
  const m = new ConversationModel();
  replayLines(m, S.replayPersistedLine, readJsonl('compaction-auto.transcript.jsonl'));
  return m;
}

describe('compaction bubble', () => {
  it('live: a manual /compact renders one compaction bubble after the untouched /compact bubble', () => {
    const m = renderLive();
    expect(shape(m)).toEqual(['user', 'compaction', 'turn_end']);
    expect(compactionLabels(m)).toEqual([MANUAL_LABEL]);
    const us = users(m);
    expect(us).toHaveLength(1);
    expect(us[0].displayText).toContain('/compact');
    expect(systemSubtypes(m)).toEqual([]); // the CLI re-init and cc's model_changed are not shown
  });

  it('live: the running bubble is the same node the boundary completes; a repeated compacting status reuses it', () => {
    const m = new ConversationModel();
    const parser = new S.Parser();
    const frames = readJsonl('compaction-manual.stdout.jsonl');
    feedFrames(m, parser, [frames[0], frames[0]]);
    expect(compactionLabels(m)).toEqual(['Compacting context…']);
    const before = m.items.find((i) => i.type === 'compaction');
    feedFrames(m, parser, frames.slice(1, 4));
    expect(m.items.filter((i) => i.type === 'compaction')).toEqual([before]);
    expect(compactionLabels(m)).toEqual([MANUAL_LABEL]);
  });

  it('reload: the persisted lines render the identical bubble, re-seated below the /compact bubble', () => {
    const live = renderLive();
    const m = renderReload();
    expect(compactionLabels(m)).toEqual(compactionLabels(live));
    expect(shape(m)).toEqual(['user', 'assistant', 'user', 'compaction']);
    const us = users(m);
    expect(us.some((u) => u.displayText.includes('<command-name>/compact</command-name>'))).toBe(true);
    for (const u of us) expect(u.displayText).not.toContain('local-command-stdout');
  });

  it('the summary rides in the bubble, not as a user bubble', () => {
    const m = renderReload();
    const c = m.items.find((i) => i.type === 'compaction') as CompactionNode;
    expect(c.summary).toContain('Primary Request and Intent');
  });

  it('live auto: one compaction bubble splitting the turn, later work below it', () => {
    const m = renderAutoLive();
    expect(compactionLabels(m)).toEqual([AUTO_LABEL]);
    expect(shape(m)).toEqual(['user', 'assistant', 'compaction', 'assistant']);
    for (const u of users(m)) expect(u.displayText).not.toContain(SUMMARY_PREFIX);
    expect((m.items[2] as CompactionNode).summary).toContain(SUMMARY_PREFIX);
    const [before, after] = assistants(m);
    expect(groupsOf(before)[0].open).toBe(false);
    expect(groupText(groupsOf(before)[0])).toBe('3 actions · thinking, Read, Bash');
    expect(groupText(groupsOf(after)[0])).toBe('3 actions · thinking, Bash, Read');
  });

  it('reload auto: the identical bubble at the identical position', () => {
    const live = renderAutoLive();
    const m = renderAutoReload();
    expect(compactionLabels(m)).toEqual(compactionLabels(live));
    expect(shape(m)).toEqual(['assistant', 'compaction', 'assistant']);
    const [before, after] = assistants(m);
    expect(groupsOf(before)[0].open).toBe(false);
    expect(groupText(groupsOf(before)[0])).toBe('3 actions · thinking, Read, Bash');
    expect(groupText(groupsOf(after)[0])).toBe('2 actions · thinking, Bash');
  });

  it('a failed compaction is shown, and a later re-init is not suppressed after it', () => {
    const m = new ConversationModel();
    const parser = new S.Parser();
    feedFrames(m, parser, [{ type: 'system', subtype: 'status', status: 'compacting' }]);
    expect(compactionLabels(m)).toEqual(['Compacting context…']);
    feedFrames(m, parser, [{ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'boom' }]);
    expect(compactionLabels(m)).toEqual(['Compaction failed: boom']);
    feedFrames(m, parser, [{ type: 'system', subtype: 'init', model: 'claude-haiku-4-5', session_id: 'abcdef123456' }]);
    expect(systemSubtypes(m)).toEqual(['model_changed', 'init']);
  });

  it('a failed compaction mid-turn splits the turn like a successful one', () => {
    const m = new ConversationModel();
    apply(m, { kind: 'user_echo', text: 'go', userIndex: 0 });
    apply(m, { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Bash' });
    apply(m, { kind: 'system', subtype: 'status', data: { status: 'compacting' } });
    apply(m, { kind: 'system', subtype: 'status', data: { status: null, compact_result: 'failed', compact_error: 'boom' } });
    apply(m, { kind: 'tool_use_start', msgId: 'm2', blockIdx: 0, toolUseId: 'tu2', name: 'Read' });
    expect(compactionLabels(m)).toEqual(['Compaction failed: boom']);
    expect(shape(m)).toEqual(['user', 'assistant', 'compaction', 'assistant']);
    const [before, after] = assistants(m);
    expect(groupsOf(before)[0].open).toBe(false);
    expect(groupText(groupsOf(before)[0])).not.toContain('Read');
    expect(groupText(groupsOf(after)[0])).toContain('Read');
  });

  it('a compaction that never reached its boundary is closed by the turn ending', () => {
    const m = new ConversationModel();
    const parser = new S.Parser();
    feedFrames(m, parser, [{ type: 'system', subtype: 'status', status: 'compacting' }]);
    feedFrames(m, parser, [{ type: 'result', subtype: 'success' }]);
    expect(compactionLabels(m)).toEqual(['Compaction did not complete']);
    feedFrames(m, parser, [{ type: 'system', subtype: 'init', model: 'm', session_id: 'abcdef123456' }]);
    expect(systemSubtypes(m)).toEqual(['model_changed', 'init']);
  });

  for (const [name, end] of [
    ['exit', { kind: 'system', subtype: 'exit', data: { code: 1, signal: null } }],
    ['crashed', { kind: 'system', subtype: 'crashed', data: { message: 'boom' } }],
  ] as const) {
    it(`a process ${name} closes a compaction that never reached its boundary`, () => {
      const m = new ConversationModel();
      apply(m, { kind: 'system', subtype: 'status', data: { status: 'compacting' } });
      apply(m, end);
      expect(compactionLabels(m)).toEqual(['Compaction did not complete']);
      apply(m, { kind: 'system', subtype: 'init', data: { model: 'm', session_id: 'abcdef123456' } });
      expect(systemSubtypes(m)).toEqual([name, 'init']);
    });
  }

  describe('absorption of the command output is scoped to a compaction', () => {
    const stdoutEcho: UiEvent = { kind: 'user_echo', text: '<local-command-stdout>x</local-command-stdout>' };
    it('a lone stdout echo with no compaction still renders as a user bubble', () => {
      const m = new ConversationModel();
      apply(m, stdoutEcho);
      expect(users(m)).toHaveLength(1);
    });
    it('after assistant content closes the window, a stdout echo renders', () => {
      const m = new ConversationModel();
      apply(m, { kind: 'compaction', trigger: 'auto', preTokens: 5, postTokens: 1, durationMs: null });
      apply(m, { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'continuing' });
      apply(m, stdoutEcho);
      expect(users(m)).toHaveLength(1);
    });
    it('a replayed turn boundary closes the window, so a stdout echo after it renders', () => {
      const m = new ConversationModel();
      apply(m, { kind: 'compaction', trigger: 'auto', preTokens: 5, postTokens: 1, durationMs: null });
      apply(m, { kind: 'turn_boundary', toolUseId: 'tuBg', status: 'completed' });
      apply(m, stdoutEcho);
      expect(users(m)).toHaveLength(1);
    });
    it('any other echo ends the window', () => {
      const m = new ConversationModel();
      apply(m, { kind: 'compaction', trigger: 'auto', preTokens: 5, postTokens: 1, durationMs: null });
      apply(m, { kind: 'user_echo', text: 'next prompt' });
      apply(m, stdoutEcho);
      expect(users(m)).toHaveLength(2);
    });
  });

  it('a summary seen without its boundary reads as a completed compaction', () => {
    const m = new ConversationModel();
    const line = readJsonl('compaction-manual.transcript.jsonl').find((l) => l.isCompactSummary === true);
    replayLines(m, S.replayPersistedLine, [line]);
    expect(compactionLabels(m)).toEqual(['Context compacted']);
    expect((m.items[0] as CompactionNode).summary).toBeTruthy();
  });
});
