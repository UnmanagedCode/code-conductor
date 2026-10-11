import { describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { ConversationModel } from './model';
import { feed, tool } from './testkit';
import { flush, renderModel } from './renderModel';

const SRC = 'data:image/png;base64,QkJCQg==';

async function withToolImage() {
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
  return r;
}

const overlay = () => document.querySelector('[data-image-overlay]');
const open = async (root: HTMLElement) => {
  fireEvent.click(root.querySelector('button[aria-label^="Enlarge"]')!);
  await flush();
};

describe('image overlay for tool-result images', () => {
  it('tapping a tool-result thumbnail opens an overlay showing the same image source', async () => {
    // Invariant: the overlay opens only on tap and its big image carries the thumbnail's exact src.
    const { root } = await withToolImage();
    expect(root.querySelector(`img[src="${SRC}"]`)).toBeTruthy();
    expect(overlay()).toBeNull();
    await open(root);
    expect(overlay()).not.toBeNull();
    expect(overlay()!.querySelector('img')!.getAttribute('src')).toBe(SRC);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Escape closes the overlay', async () => {
    // Invariant: Escape dismisses it (control: it was open first).
    const { root } = await withToolImage();
    await open(root);
    expect(overlay()).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await flush();
    expect(overlay()).toBeNull();
  });

  it('a press on the backdrop closes the overlay', async () => {
    // Invariant: pressing outside the image dismisses it.
    const { root } = await withToolImage();
    await open(root);
    expect(overlay()).not.toBeNull();
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;
    await act(async () => {
      fireEvent.pointerDown(backdrop);
      fireEvent.pointerUp(backdrop);
      fireEvent.click(backdrop);
    });
    await flush();
    expect(overlay()).toBeNull();
  });

  it('tapping the big image toggles full size and keeps the overlay open; a later close then reopens fit-to-screen', async () => {
    // Invariant: a tap on the big image swaps between fit and actual size (title swaps) and never closes; reopening starts at fit.
    const { root } = await withToolImage();
    await open(root);
    const big = () => overlay()!.querySelector('img')!;
    const fitTitle = big().getAttribute('title');
    fireEvent.click(big());
    await flush();
    expect(overlay()).not.toBeNull();
    const fullTitle = big().getAttribute('title');
    expect(fullTitle).not.toBe(fitTitle);
    fireEvent.click(big());
    await flush();
    expect(big().getAttribute('title')).toBe(fitTitle);
    fireEvent.click(big());
    await flush();
    expect(big().getAttribute('title')).toBe(fullTitle);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await flush();
    expect(overlay()).toBeNull();
    await open(root);
    expect(big().getAttribute('title')).toBe(fitTitle);
  });

  it('a press on the backdrop still closes the overlay after zooming to full size', async () => {
    // Invariant: zoomed state does not stop the backdrop from dismissing the overlay.
    const { root } = await withToolImage();
    await open(root);
    const big = () => overlay()!.querySelector('img')!;
    const fitTitle = big().getAttribute('title');
    fireEvent.click(big());
    await flush();
    expect(big().getAttribute('title')).not.toBe(fitTitle);
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;
    await act(async () => {
      fireEvent.pointerDown(backdrop);
      fireEvent.pointerUp(backdrop);
      fireEvent.click(backdrop);
    });
    await flush();
    expect(overlay()).toBeNull();
  });

  it('an image that is not wrapped for zoom does nothing when tapped', async () => {
    // Invariant: only the zoomable thumbnails open an overlay; a plain image elsewhere in the page opens none.
    const { root } = await withToolImage();
    const plain = document.createElement('img');
    plain.setAttribute('src', '/icon.png');
    root.appendChild(plain);
    fireEvent.click(plain);
    await flush();
    expect(overlay()).toBeNull();
    cleanup();
  });
});
