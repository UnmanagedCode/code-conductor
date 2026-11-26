// How a user echo that leads with a composer-sent context chip reads in the transcript. The chip is
// recognised only from the marker cc writes (shared/contextChip.ts), never from a typed "Context:" line.
import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { composeChipMessage } from '@shared/contextChip';
import { promptOrigin } from '@shared/promptOrigin';
import { ConversationModel, type UserNode } from './model';
import { flush, renderModel } from './renderModel';
import { serverModules } from './testkit';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

const CHIP = { title: 'main.ts · 3 lines', data: 'const a = 1;\nconst b = 2;\nconst c = 3;' };
const userNode = (m: ConversationModel) => m.items.find((i): i is UserNode => i.type === 'user')!;
const echo = (text: string) => {
  const m = new ConversationModel();
  m.apply({ kind: 'user_echo', text, userIndex: 0 });
  return m;
};

describe('a user echo that leads with a context chip', () => {
  // Invariant: the chip becomes the node's contextChip and the bubble's text is what was typed after
  // it; rewind and fork still get the full sent text.
  it('node.contextChip carries the chip and displayText is the typed text', () => {
    const sent = composeChipMessage(CHIP, 'what does this do?');
    const n = userNode(echo(sent));
    expect(n.contextChip).toEqual(CHIP);
    expect(n.displayText).toBe('what does this do?');
    expect(n.rawText).toBe(sent);
    expect(n.variant).toBe('plain');
    expect(n.origin).toBe('typed');
  });

  // Invariant: a chip sent with no typed text leaves an empty body and still counts as the person's prompt.
  it('a chip-only send has an empty displayText', () => {
    const n = userNode(echo(composeChipMessage(CHIP, '')));
    expect(n.contextChip).toEqual(CHIP);
    expect(n.displayText).toBe('');
    expect(promptOrigin({ text: composeChipMessage(CHIP, '') })).toBe('typed');
  });

  // Invariant: dictation after a chip keeps its voice badge and the tag is stripped from the shown text.
  it('<transcribed> after a chip keeps the voice badge', () => {
    const n = userNode(echo(composeChipMessage(CHIP, '<transcribed>\nspoken words')));
    expect(n.contextChip).toEqual(CHIP);
    expect(n.transcribed).toBe(true);
    expect(n.displayText).toBe('spoken words');
  });

  // Invariant (decision 1): an unmarked Context: block is plain text — no chip row, the whole text shown.
  it('an unmarked Context: block stays text', () => {
    const typed = 'Context: main.ts · 3 lines\n```\nconst a = 1;\n```\n\nwhat does this do?';
    const n = userNode(echo(typed));
    expect(n.contextChip).toBeNull();
    expect(n.displayText).toBe(typed);
  });

  // Invariant: what follows a chip is the person's text — a wake marker typed there does not turn the bubble into an injected fold.
  it('text after a chip is never read as an injected turn', () => {
    const n = userNode(echo(composeChipMessage(CHIP, '[[cc:wake-callback]] Worker `x` finished')));
    expect(n.variant).toBe('plain');
    expect(n.wake).toBeNull();
  });

  // Invariant: the live echo (the composed text as a user_echo) and the replayed one (the same text
  // through src/parser.ts's user record) build the same node.
  it('a fixture replayed through the server parser renders the same node as live', () => {
    const sent = composeChipMessage(CHIP, 'typed');
    const live = userNode(echo(sent));
    const replayed = new ConversationModel();
    for (const ev of new S.Parser().handleObject({ type: 'user', message: { role: 'user', content: sent } })) replayed.apply(ev);
    const r = userNode(replayed);
    expect(r.contextChip).toEqual(live.contextChip);
    expect(r.displayText).toBe(live.displayText);
    expect(r.rawText).toBe(live.rawText);
  });
});

describe('the bubble', () => {
  // Invariant: the bubble shows the chip's title above the typed text, with the data behind a fold
  // that expands.
  it('[data-user-context-chip] shows the title and expands the data', async () => {
    const m = echo(composeChipMessage(CHIP, 'typed words'));
    const { root } = renderModel(m);
    await flush();
    const row = root.querySelector('[data-user-context-chip]') as HTMLElement;
    expect(row.textContent).toContain(CHIP.title);
    expect(row.querySelector('[data-context-chip-data]')).toBeNull();
    fireEvent.click(row.querySelector('[data-fold-trigger]')!);
    await flush();
    expect(row.querySelector('[data-context-chip-data]')!.textContent).toBe(CHIP.data);
    expect(root.querySelector('[data-user-text]')!.textContent).toContain('typed words');
    expect(root.querySelector('[data-user-text]')!.textContent).not.toContain(CHIP.title);
  });

  it('a plain message has no chip row', async () => {
    const { root } = renderModel(echo('just typed'));
    await flush();
    expect(root.querySelector('[data-user-context-chip]')).toBeNull();
  });
});
