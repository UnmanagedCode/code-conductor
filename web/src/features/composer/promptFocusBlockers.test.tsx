import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';
import { focusPromptAfterSelect } from '@/features/session/promptFocus';
import { ConversationModel } from '@/conversation/model';
import { feed, tool } from '@/conversation/testkit';
import { flush, renderModel } from '@/conversation/renderModel';

const win = { matchMedia: () => ({ matches: false }) } as unknown as Window & typeof globalThis;
const prompt = () => document.getElementById('p') as HTMLTextAreaElement;

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('prompt focus and overlays', () => {
  const setup = () => { document.body.innerHTML = '<textarea id="p"></textarea><button id="b">go</button>'; };

  it('an open aria-modal overlay keeps focus where it was; a hidden one does not block', () => {
    // Invariant: only a shown modal overlay stops the prompt from taking focus.
    setup();
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlay);
    focusPromptAfterSelect(true, prompt(), { win });
    expect(document.activeElement).not.toBe(prompt());
    overlay.hidden = true;
    focusPromptAfterSelect(true, prompt(), { win });
    expect(document.activeElement).toBe(prompt());
  });

  it('a focused button does not block focusing the prompt', () => {
    // Invariant: focus resting on a button (not a text field) is not "the user is typing".
    setup();
    (document.getElementById('b') as HTMLElement).focus();
    expect(document.activeElement).toBe(document.getElementById('b'));
    focusPromptAfterSelect(true, prompt(), { win });
    expect(document.activeElement).toBe(prompt());
  });

  it('the real image overlay blocks it while open and stops blocking once closed', async () => {
    // Invariant: the app's lightbox (the image overlay) is one of the overlays that keep focus.
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 't1', 'Read', { result: null, input: { file_path: 'x.png' } }),
      { kind: 'tool_result', toolUseId: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QkJCQg==' } }] },
    ]);
    const r = renderModel(m);
    await flush();
    const group = within(r.root).getByRole('button', { name: /action/i });
    if (group.getAttribute('data-state') === 'closed') fireEvent.click(group);
    for (const t of r.root.querySelectorAll('[data-tool-trigger]')) if (t.getAttribute('data-state') === 'closed') fireEvent.click(t);
    await flush();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    fireEvent.click(r.root.querySelector('button[aria-label^="Enlarge"]')!);
    await flush();
    expect(document.querySelector('[data-image-overlay]')).not.toBeNull();
    focusPromptAfterSelect(true, ta, { win });
    expect(document.activeElement).not.toBe(ta);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await flush();
    expect(document.querySelector('[data-image-overlay]')).toBeNull();
    focusPromptAfterSelect(true, ta, { win });
    expect(document.activeElement).toBe(ta);
  });
});
