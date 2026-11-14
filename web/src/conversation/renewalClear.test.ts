import { beforeAll, describe, expect, it } from 'vitest';
import { ConversationModel, isClearCommandText } from './model';
import { apply, readJsonl, replayLines, serverModules, shape, users } from './testkit';
import type { UiEvent } from '@shared/uiEvent';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

const SEAM: UiEvent = { kind: 'segment_seam', segmentId: 'post' };
const fixture = () => readJsonl('renew-post-segment.transcript.jsonl');
const replayOf = (lines: any[]) => lines.flatMap((l) => S.replayPersistedLine(l));
const userEchoes = (evs: UiEvent[]) => evs.filter((e): e is Extract<UiEvent, { kind: 'user_echo' }> => e.kind === 'user_echo');
const seedEcho = () => userEchoes(replayOf(fixture())).at(-1)!;
const clearEcho = () => userEchoes(replayOf(fixture()))[0];
const bubbleTexts = (m: ConversationModel) => users(m).map((u) => u.rawText);

function reload(lines = fixture()) {
  const m = new ConversationModel();
  apply(m, SEAM);
  replayLines(m, S.replayPersistedLine, lines);
  return m;
}

describe('a renewal\'s /clear command line on the load path', () => {
  it('reload: a managed renewal\'s /clear echo is absorbed by the divider', () => {
    const m = reload();
    expect(shape(m)).toEqual(['divider', 'user', 'assistant']);
    expect(users(m).map((u) => u.variant)).toEqual(['renew']);
    expect(bubbleTexts(m).some((t) => t.includes('<command-name>'))).toBe(false);
  });

  it('reload matches live: same shape and the same user bubble as the ring-built view', () => {
    const live = new ConversationModel();
    apply(live, SEAM);
    apply(live, seedEcho());
    for (const ev of replayOf(fixture()).filter((e) => e.kind !== 'user_echo')) apply(live, ev);
    const loaded = reload();
    expect(shape(loaded)).toEqual(shape(live));
    expect(users(loaded).map((u) => [u.variant, u.displayText])).toEqual(users(live).map((u) => [u.variant, u.displayText]));
  });

  it('a typed /clear keeps its bubble: no reseed follows it', () => {
    const lines = fixture().map((l) => (l.type === 'user' && Array.isArray(l.message?.content)
      ? { ...l, message: { role: 'user', content: 'tidy the docs' } } : l));
    const m = reload(lines);
    const items = m.items;
    const at = items.findIndex((i) => i.type === 'user' && i.rawText.startsWith('<command-name>/clear'));
    expect(at).toBe(1);
    expect(items[0]).toMatchObject({ type: 'divider', kind: 'seam' });
  });

  it('another command echo under a seam is untouched', () => {
    const compact = readJsonl('compaction-manual.transcript.jsonl')
      .flatMap((l) => S.replayPersistedLine(l)).find((e) => e.kind === 'user_echo' && e.text.startsWith('<command-name>/compact'))!;
    const m = new ConversationModel();
    apply(m, SEAM);
    apply(m, compact);
    apply(m, seedEcho());
    expect(bubbleTexts(m).some((t) => t.startsWith('<command-name>/compact'))).toBe(true);
  });

  it('a /clear echo not directly followed by the reseed is untouched', () => {
    const m = new ConversationModel();
    apply(m, clearEcho());
    apply(m, { kind: 'user_echo', text: 'a prompt in between', userIndex: 1 });
    apply(m, seedEcho());
    expect(bubbleTexts(m).some((t) => t.startsWith('<command-name>/clear'))).toBe(true);
    const n = new ConversationModel();
    apply(n, clearEcho());
    apply(n, { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'reply' });
    apply(n, { kind: 'text_end', msgId: 'm1', blockIdx: 0 });
    apply(n, seedEcho());
    expect(bubbleTexts(n).some((t) => t.startsWith('<command-name>/clear'))).toBe(true);
  });

  it('resume path: snapshot holds echo + seed with no seam, then a [seam]-only page is prepended', () => {
    const m = new ConversationModel();
    m.applyEvents([
      clearEcho(),
      seedEcho(),
      { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'Resumed from the summary.' },
      { kind: 'text_end', msgId: 'm1', blockIdx: 0 },
    ] as UiEvent[]);
    m.prependPage(m.renderPage([SEAM], 'post', 'post'), m.leadingAssistantWrap);
    expect(shape(m)).toEqual(['divider', 'user', 'assistant']);
    expect(users(m).map((u) => u.variant)).toEqual(['renew']);
    expect(bubbleTexts(m).some((t) => t.includes('<command-name>'))).toBe(false);
  });

  it('fork: echo + seed with no seam at all', () => {
    const m = new ConversationModel();
    replayLines(m, S.replayPersistedLine, fixture());
    expect(shape(m)).toEqual(['user', 'assistant']);
    expect(users(m).map((u) => u.variant)).toEqual(['renew']);
    expect(bubbleTexts(m).some((t) => t.includes('<command-name>'))).toBe(false);
  });

  it('isClearCommandText: true for the recorded wrapper, false when the tag or /clear is only mentioned mid-text', () => {
    expect(isClearCommandText(clearEcho().text)).toBe(true);
    expect(isClearCommandText('why is <command-name>/clear</command-name> in my log')).toBe(false);
    expect(isClearCommandText('why is /clear in my log')).toBe(false);
  });

  it('a plain prompt mentioning the /clear tag mid-text directly above the reseed keeps its bubble', () => {
    const m = new ConversationModel();
    apply(m, { kind: 'user_echo', text: 'why is <command-name>/clear</command-name> in my log', userIndex: 0 });
    apply(m, seedEcho());
    expect(bubbleTexts(m)).toContain('why is <command-name>/clear</command-name> in my log');
  });

  it('paged: the echo ends the older page and the seed heads the newer one', () => {
    const m = new ConversationModel();
    m.applyEvents([
      seedEcho(),
      { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'Resumed from the summary.' },
      { kind: 'text_end', msgId: 'm1', blockIdx: 0 },
    ] as UiEvent[]);
    const page = m.renderPage([SEAM, clearEcho()], 'post', 'post');
    m.prependPage(page, m.leadingAssistantWrap);
    expect(shape(m)).toEqual(['divider', 'user', 'assistant']);
    expect(users(m).map((u) => u.variant)).toEqual(['renew']);
    expect(bubbleTexts(m).some((t) => t.includes('<command-name>'))).toBe(false);
  });
});
