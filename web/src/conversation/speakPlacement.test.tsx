// Where a finished text block's read-aloud sits: inside the block's last line of prose
// (a slot at the inline end of its last paragraph, list item or quote) or on a row of its
// own when the block ends in a heading, code block, table or rule; and which blocks
// move it into the avatar gutter at `md` and up (every one but the bubble's first). The
// geometry itself is checked in the browser (web/e2e/speaker-gutter.shared.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { voiceStore } from '@/features/voice/store';
import * as tts from '@/features/voice/tts';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel, type AssistantNode, type TextNode } from './model';
import { flush, renderModel } from './renderModel';
import { text, tool } from './testkit';

beforeEach(() => {
  act(() => { voiceStore.set({ ttsAvailable: true }); });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => { voiceStore.set({ ttsAvailable: false }); tts.speakStore.set({ activeNodeId: null }); });
});

async function show(events: UiEvent[], m = new ConversationModel()) {
  m.applyEvents(events);
  const { root } = renderModel(m);
  await flush();
  return { m, root };
}
async function live(m: ConversationModel, events: UiEvent[]) {
  act(() => { for (const ev of events) m.apply(ev); });
  await flush();
}

/** The transcript's outer assistant bubbles, not the sub-agent bubbles nested in one. */
const bubbles = (root: HTMLElement) =>
  ([...root.querySelectorAll('[data-item="assistant"]')] as HTMLElement[]).filter((b) => !b.parentElement!.closest('[data-item="assistant"]'));
/** The outer bubble's own text blocks in document order. */
const blocks = (root: HTMLElement) => {
  const b = bubbles(root)[0];
  return ([...b.querySelectorAll('[data-text-block]')] as HTMLElement[]).filter((w) => w.closest('[data-item="assistant"]') === b);
};
const md = (block: HTMLElement) => block.querySelector('.md') as HTMLElement;
const speakers = (scope: HTMLElement) =>
  ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).filter((x) => /^(Read aloud|Stop reading)$/.test(x.getAttribute('aria-label') ?? ''));
/** The block's one read-aloud control. */
function speaker(block: HTMLElement) {
  const all = speakers(block);
  expect(all.length, 'the block holds exactly one read-aloud control').toBe(1);
  return all[0];
}
const textNodes = (m: ConversationModel) => (m.items[0] as AssistantNode).children.filter((c): c is TextNode => c.type === 'text');
const describeEl = (el: Element | null) => (el ? `<${el.tagName.toLowerCase()}${[...el.attributes].map((a) => ` ${a.name}`).join('')}>` : 'null');

/** Asserts the button sits alone in an inline slot whose parent is `host`; returns the slot. */
function expectInlineIn(button: HTMLElement, host: Element | null, msg: string) {
  expect(host, `fixture check: ${msg}: the expected host exists`).toBeTruthy();
  const slot = button.parentElement!;
  expect(slot.matches('span[data-speak-slot]'), `${msg}: the control's parent is the inline slot, not ${describeEl(slot)}`).toBe(true);
  expect(slot.parentElement === host, `${msg}: the slot sits in ${describeEl(host)}, not ${describeEl(slot.parentElement)}`).toBe(true);
  expect(slot.childNodes.length === 1 && slot.firstChild === button, `${msg}: the slot holds nothing but the control`).toBe(true);
  return slot;
}

const PROSE_THEN_LATER = (first: string) => [...text('m1', 0, first), ...tool('m1', 1, 't1', 'Bash'), ...text('m1', 2, 'Later line.')];

describe('read-aloud placement', () => {
  // Pins: a block ending in prose puts its control in a slot at the inline end of its last p / li / quote, adding no text.
  it.each([
    { kind: 'paragraph', src: 'First para.\n\nSecond **para** end.', host: ':scope > p:last-child', own: 'Second para end.' },
    { kind: 'list', src: 'Intro:\n\n- one\n- two **end**', host: ':scope > ul:last-child > li:last-child', own: 'two end' },
    { kind: 'quote', src: 'Body.\n\n> quoted end', host: ':scope > blockquote:last-child', own: 'quoted end' },
  ])('a block ending in a $kind holds its control after the last word', async ({ src, host, own }) => {
    const { root } = await show(text('m1', 0, src));
    const [block] = blocks(root);
    const button = speaker(block);
    const hostEl = md(block).querySelector(host);
    const slot = expectInlineIn(button, hostEl, 'inline end');
    expect(hostEl!.textContent!.trim(), 'the control adds no text to the line it ends').toBe(own);
    expect(slot.hasAttribute('aria-hidden') || button.hasAttribute('aria-hidden'), 'neither the slot nor the control is hidden from assistive tech').toBe(false);
    expect(block.getAttribute('data-speak-end')).toBe('inline');
  });

  // Pins: a block ending in a heading, code block, table or rule keeps the control on a row of its own after the prose, with no slot in the markdown; a heading's name never takes in the control.
  it.each([
    { kind: 'heading', src: 'Body.\n\n## Closing words', last: 'h2' },
    { kind: 'code block', src: 'Run:\n\n```\nnpm test\n```', last: '.md-code-wrap' },
    { kind: 'table', src: 'Intro:\n\n| a | b |\n|---|---|\n| 1 | 2 |', last: 'table' },
    { kind: 'rule', src: 'text\n\n---', last: 'hr' },
  ])('a block ending in a $kind keeps its control on a row of its own', async ({ src, last }) => {
    const { root } = await show(text('m1', 0, src));
    const [block] = blocks(root);
    const button = speaker(block);
    const lastEl = md(block).lastElementChild;
    expect(!!lastEl?.matches(last), `fixture check: the markdown ends in ${last}, not ${describeEl(lastEl)}`).toBe(true);
    expect(lastEl!.contains(button), 'the control is not inside the last block').toBe(false);
    expect(md(block).querySelector('[data-speak-slot]'), 'the markdown holds no slot').toBeNull();
    const row = button.parentElement!;
    expect(row.matches('div[data-speak-slot]'), `the control's parent is the row, not ${describeEl(row)}`).toBe(true);
    expect(row.parentElement === block, 'the row is the block\'s own child').toBe(true);
    expect(!!row.previousElementSibling?.contains(md(block)), 'the row follows the prose').toBe(true);
    expect(block.getAttribute('data-speak-end')).toBe('row');
  });

  // Pins: the bubble's first block (beside the avatar) ends inline and never moves into the gutter.
  it('the first block of a bubble, ending in prose, ends inline and stays out of the gutter', async () => {
    const { root } = await show(PROSE_THEN_LATER('Opening line.'));
    const [first] = blocks(root);
    expect(blocks(root).length, 'fixture check: two text blocks around a tool').toBe(2);
    expect(first.getAttribute('data-speak-end')).toBe('inline');
    expect(first.hasAttribute('data-speak-gutter'), 'the first block keeps the gutter for the avatar').toBe(false);
  });

  // Pins: every later block ending in prose ends inline and is marked for the gutter.
  it('a later block, ending in prose, ends inline and is marked for the gutter', async () => {
    const { root } = await show(PROSE_THEN_LATER('Opening line.'));
    const [, later] = blocks(root);
    expect(later.getAttribute('data-speak-end')).toBe('inline');
    expect(later.hasAttribute('data-speak-gutter'), 'a later block moves its control into the gutter').toBe(true);
  });

  // Pins: the first block ending in code falls back to its own row and stays out of the gutter.
  it('the first block of a bubble, ending in a code block, keeps its own row and stays out of the gutter', async () => {
    const { root } = await show(PROSE_THEN_LATER('Run:\n\n```\nnpm test\n```'));
    const [first] = blocks(root);
    expect(first.getAttribute('data-speak-end')).toBe('row');
    expect(first.hasAttribute('data-speak-gutter')).toBe(false);
  });

  // Pins: a later block ending in code is on a row and still marked for the gutter.
  it('a later block, ending in a code block, keeps its own row and is marked for the gutter', async () => {
    const { root } = await show([...text('m1', 0, 'Opening line.'), ...tool('m1', 1, 't1', 'Bash'), ...text('m1', 2, 'Run:\n\n```\nnpm test\n```')]);
    const [, later] = blocks(root);
    expect(later.getAttribute('data-speak-end')).toBe('row');
    expect(later.hasAttribute('data-speak-gutter')).toBe(true);
  });

  // Pins: with no voice the block carries no slot and no placement attribute; a voice arriving adds exactly one control, inline.
  it('with no voice there is no slot; a voice arriving puts exactly one control in the last paragraph', async () => {
    act(() => { voiceStore.set({ ttsAvailable: false }); });
    const { root } = await show(text('m1', 0, 'First.\n\nLast **one**.'));
    const [block] = blocks(root);
    expect(root.querySelector('[data-speak-slot]'), 'no slot without a voice').toBeNull();
    expect(block.hasAttribute('data-speak-end'), 'no placement without a voice').toBe(false);
    expect(speakers(block), 'no control without a voice').toEqual([]);
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    await flush();
    expectInlineIn(speaker(block), md(block).querySelector(':scope > p:last-child'), 'once the voice arrives');
    expect(block.querySelectorAll('[data-speak-slot]').length, 'exactly one slot').toBe(1);
  });

  // Pins: a finished block that grows re-renders into a fresh slot in its latest last block; the old slot is detached and emptied, never duplicated.
  it('a finished block that keeps growing holds one control, always in its latest last block', async () => {
    const { m, root } = await show([{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'Hello ' }]);
    await live(m, [{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'there.' }]);
    const [block] = blocks(root);
    expect(block.textContent, 'positive control: the streamed text grew').toContain('Hello there.');
    expect(speakers(block), 'a streaming block has no control').toEqual([]);

    await live(m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 0 }]);
    let slot = expectInlineIn(speaker(block), md(block).querySelector(':scope > p:last-child'), 'once finished');

    const growths = [
      { delta: '\n\n- item **x**', host: ':scope > ul:last-child > li:last-child', buffer: 'Hello there.\n\n- item **x**' },
      { delta: '\n\nTail para.', host: ':scope > p:last-child', buffer: 'Hello there.\n\n- item **x**\n\nTail para.' },
    ];
    for (const g of growths) {
      const previous = slot;
      await live(m, [{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: g.delta }]);
      const [node] = textNodes(m);
      expect([node.finalized, node.buffer], 'fixture check: the finished block grew in place').toEqual([true, g.buffer]);
      slot = expectInlineIn(speaker(block), md(block).querySelector(g.host), `after growing by ${JSON.stringify(g.delta)}`);
      expect(previous.isConnected, 'the previous slot is gone from the document').toBe(false);
      expect(previous.childNodes.length, 'the previous slot was emptied').toBe(0);
      expect(block.querySelectorAll('[data-speak-slot]').length, 'exactly one slot in the block').toBe(1);
    }
  });

  // Pins: the raw view ends inline after the source text; returning to rendered leaves one control in the last paragraph and no raw-era slot.
  it('the raw view holds the control after the source text, and returning to rendered moves it back', async () => {
    const { root } = await show(text('m1', 0, 'First.\n\nLast **one**.'));
    const b = bubbles(root)[0];
    fireEvent.click(b.querySelector('button[aria-label="Show raw text"]')!);
    await flush();
    const [block] = blocks(root);
    expect(block.textContent, 'fixture check: the raw view shows the source').toContain('Last **one**.');
    expect(block.getAttribute('data-speak-end')).toBe('inline');
    const rawSlot = speaker(block).parentElement!;
    expect(rawSlot.matches('span[data-speak-slot]'), `the raw view's control sits in a slot, not ${describeEl(rawSlot)}`).toBe(true);
    const rawDiv = rawSlot.parentElement!;
    expect(rawDiv.lastChild === rawSlot, 'the slot is the raw text\'s last child').toBe(true);
    expect(!!(rawDiv.firstChild!.compareDocumentPosition(rawSlot) & Node.DOCUMENT_POSITION_FOLLOWING) && rawDiv.firstChild!.nodeType === Node.TEXT_NODE, 'the slot follows the source text').toBe(true);

    fireEvent.click(b.querySelector('button[aria-label="Show rendered markdown"]')!);
    await flush();
    expectInlineIn(speaker(block), md(block).querySelector(':scope > p:last-child'), 'back in the rendered view');
    expect(rawSlot.isConnected, 'the raw view\'s slot is gone').toBe(false);
    expect(block.querySelectorAll('[data-speak-slot]').length, 'exactly one slot in the block').toBe(1);
  });

  // Pins: the control is muted, not hidden, at rest, and full strength on its own segment's hover, on keyboard focus and where nothing hovers.
  it('the control is muted at rest and full strength on its segment\'s hover, on focus and on touch', async () => {
    const { root } = await show(text('m1', 0, 'Just one line.'));
    const [block] = blocks(root);
    const button = speaker(block);
    expect(block.classList.contains('group/speak'), 'the block is the hover group').toBe(true);
    for (const c of ['group-hover/speak:opacity-100', 'focus-visible:opacity-100', '[@media(hover:none)]:opacity-100']) {
      expect(button.classList.contains(c), `the control carries ${c}`).toBe(true);
    }
    for (let el: HTMLElement | null = button; el && el !== block.parentElement; el = el.parentElement) {
      expect(el.classList.contains('opacity-0'), `${describeEl(el)} hides the control at rest`).toBe(false);
    }
  });

  // Pins: the portalled control still reads its own block and follows playback state.
  it('the inline control reads its block and follows playback', async () => {
    const { m, root } = await show(text('m1', 0, 'Read **this** line.'));
    const [block] = blocks(root);
    const slot = expectInlineIn(speaker(block), md(block).querySelector(':scope > p:last-child'), 'precondition');
    const [node] = textNodes(m);
    const toggle = vi.spyOn(tts, 'toggleSpeak').mockImplementation(() => {});
    fireEvent.click(speaker(block));
    expect(toggle.mock.calls, 'the control hands its own block to the speech toggle').toEqual([[node.buffer, node.id]]);
    act(() => { tts.speakStore.set({ activeNodeId: node.id }); });
    await flush();
    const playing = slot.querySelector('button')!;
    expect(playing?.getAttribute('aria-label'), 'the same slot\'s control offers to stop').toBe('Stop reading');
    expect(playing.getAttribute('aria-pressed')).toBe('true');
  });

  // Pins: a sub-agent bubble gets no slot and no placement attribute, while the outer bubble does.
  it('a sub-agent bubble carries no slot and no placement', async () => {
    const { root } = await show([
      ...text('m1', 0, 'A'),
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S' }] } },
      ...text('m1', 2, 'B'),
    ]);
    const outer = bubbles(root)[0];
    fireEvent.click(outer.querySelector('[data-group-trigger]') as HTMLElement);
    await flush();
    const sub = ([...root.querySelectorAll('[data-item="assistant"]')] as HTMLElement[]).find((x) => !!x.parentElement!.closest('[data-item="assistant"]'));
    expect(sub, "fixture check: the sub-agent's bubble is on screen").toBeTruthy();
    expect(blocks(root).filter((w) => w.querySelector('[data-speak-slot]')).length, 'positive control: the outer bubble has slots').toBe(2);
    expect(sub!.querySelector('[data-speak-slot]'), 'no slot in the sub-agent bubble').toBeNull();
    expect(sub!.querySelector('[data-speak-end]'), 'no placement in the sub-agent bubble').toBeNull();
  });

  // Pins: when the rendered view or the voice comes back, the control is never mounted, even for one commit, into the slot of an earlier render.
  it.each([
    {
      arm: 'the rendered view returns from raw',
      leave: async (b: HTMLElement) => { fireEvent.click(b.querySelector('button[aria-label="Show raw text"]')!); await flush(); },
      back: async (b: HTMLElement) => { fireEvent.click(b.querySelector('button[aria-label="Show rendered markdown"]')!); await flush(); },
    },
    {
      arm: 'the voice returns',
      leave: async () => { act(() => { voiceStore.set({ ttsAvailable: false }); }); await flush(); },
      back: async () => { act(() => { voiceStore.set({ ttsAvailable: true }); }); await flush(); },
    },
  ])('when $arm, the control mounts only in the fresh slot, never in the old one', async ({ leave, back }) => {
    const { root } = await show(text('m1', 0, 'First.\n\nLast **one**.'));
    const b = bubbles(root)[0];
    const [block] = blocks(root);
    const oldSlot = expectInlineIn(speaker(block), md(block).querySelector(':scope > p:last-child'), 'positive control: the observed slot is the one holding the control');
    await leave(b);
    expect(oldSlot.isConnected, 'fixture check: the old slot is detached').toBe(false);
    expect(oldSlot.childNodes.length, 'fixture check: the old slot was emptied').toBe(0);

    /** Read-aloud buttons added under `node`, with the element each was added to. */
    const watch = (node: Node, subtree: boolean) => {
      const seen: MutationRecord[] = [];
      const obs = new MutationObserver((rs) => { seen.push(...rs); });
      obs.observe(node, { childList: true, subtree });
      return () => {
        seen.push(...obs.takeRecords());
        obs.disconnect();
        return seen.flatMap((r) => [...r.addedNodes]
          .filter((n): n is HTMLElement => n instanceof HTMLElement && /^(Read aloud|Stop reading)$/.test(n.getAttribute('aria-label') ?? ''))
          .map((n) => ({ button: n, into: r.target })));
      };
    };
    const intoOld = watch(oldSlot, false);
    const intoBlock = watch(block, true);
    await back(b);

    const fresh = expectInlineIn(speaker(block), md(block).querySelector(':scope > p:last-child'), 'once it returns');
    expect(fresh !== oldSlot, 'fixture check: the control sits in a fresh slot').toBe(true);
    expect(intoBlock().some((m) => m.into === fresh), 'positive control: the observers record the control mounting in the fresh slot').toBe(true);
    expect(intoOld().length, 'nothing was ever mounted in the old slot').toBe(0);
  });
});
