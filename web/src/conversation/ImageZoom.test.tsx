import { describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { ConversationModel } from './model';
import { feed, tool, toolResult } from './testkit';
import { flush, renderModel } from './renderModel';

const SRC = 'data:image/png;base64,QkJCQg==';

async function withToolImage() {
  const m = new ConversationModel();
  feed(m, [
    ...tool('m1', 0, 't1', 'Read', { result: null, input: { file_path: 'x.png' } }),
    toolResult({ toolUseId: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QkJCQg==' } }] }),
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

function stubGeometry(el: HTMLElement, props: Record<string, number>) {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { configurable: true, value: v });
}
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

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

describe('image overlay zoom position', () => {
  it('zooming keeps the same scroll container, whose only child is the image', async () => {
    // Invariant: fit→actual does not remount the scroller (so its scroll position can be set) and the img is its sole element child.
    const { root } = await withToolImage();
    await open(root);
    const before = overlay()!;
    fireEvent.click(before.querySelector('img')!);
    await flush();
    expect(overlay() === before).toBe(true);
    expect(before.children).toHaveLength(1);
    expect(before.children[0].tagName).toBe('IMG');
  });

  it('a tap on the fit image scrolls the zoomed view so the tapped spot sits under the pointer', async () => {
    // Invariant: after fit→actual the scroller is positioned by zoomScroll from the tap, and zooming back out sets no new position.
    const { root } = await withToolImage();
    await open(root);
    const img = overlay()!.querySelector('img')! as HTMLImageElement;
    stubGeometry(img, { naturalWidth: 3000, naturalHeight: 2000 });
    // Fit box 400×400 at (100,50): painted 400×266.67, tap at its (75%, 25%).
    img.getBoundingClientRect = () => rect(100, 50, 400, 400);
    const painted = (400 * 2000) / 3000;
    const inset = (400 - painted) / 2;
    const tap = { x: 100 + 300, y: 50 + inset + painted * 0.25 };
    const wrapper = overlay() as HTMLElement;
    stubGeometry(wrapper, { clientWidth: 1000, clientHeight: 800 });
    wrapper.getBoundingClientRect = () => rect(20, 10, 1000, 800);
    fireEvent.click(img, { clientX: tap.x, clientY: tap.y });
    await flush();
    const pointer = { x: tap.x - 20, y: tap.y - 10 };
    // happy-dom lays out at 0 and may clamp an assigned scroll; probe that first.
    const probe = document.createElement('div');
    probe.scrollLeft = 5;
    expect(probe.scrollLeft, 'positive control: happy-dom keeps an assigned scrollLeft').toBe(5);
    expect(wrapper.scrollLeft).toBe(Math.min(2000, Math.max(0, 0.75 * 3000 - pointer.x)));
    expect(wrapper.scrollTop).toBeCloseTo(Math.min(1200, Math.max(0, 0.25 * 2000 - pointer.y)), 3);
  });

  it('the pointer origin is the zoomed scroller\'s rect, not the fit-mode wrapper\'s', async () => {
    // Invariant: the wrapper's rect is read after the zoom lands (its top moves when it grows), so the scroll comes from the post-zoom origin.
    const { root } = await withToolImage();
    await open(root);
    const img = overlay()!.querySelector('img')! as HTMLImageElement;
    stubGeometry(img, { naturalWidth: 3000, naturalHeight: 1000 });
    img.getBoundingClientRect = () => rect(50, 100, 600, 200); // painted exactly: 3:1
    const wrapper = overlay() as HTMLElement;
    stubGeometry(wrapper, { clientWidth: 1000, clientHeight: 500 });
    const fitRect = rect(30, 100, 600, 200);
    const actualRect = rect(50, 10, 1000, 500);
    wrapper.getBoundingClientRect = () => (img.getAttribute('title') === 'Fit to screen' ? actualRect : fitRect);
    fireEvent.click(img, { clientX: 350, clientY: 150 }); // fx 0.5, fy 0.25
    await flush();
    // Post-zoom origin (50, 10): pointer (300, 140) → (1200, 110); the fit origin (30, 100) would give (1180, 200).
    expect(wrapper.scrollLeft).toBe(1200);
    expect(wrapper.scrollTop).toBe(110);
  });

  it('a tap outside the zoomed scroller\'s client box is clamped to it', async () => {
    // Invariant: the pointer offset is clamped to [0, client size]; unclamped it would give left 2550 and top 1560.
    const { root } = await withToolImage();
    await open(root);
    const img = overlay()!.querySelector('img')! as HTMLImageElement;
    stubGeometry(img, { naturalWidth: 3000, naturalHeight: 2000 });
    img.getBoundingClientRect = () => rect(100, 50, 400, 400);
    const wrapper = overlay() as HTMLElement;
    stubGeometry(wrapper, { clientWidth: 400, clientHeight: 300 });
    wrapper.getBoundingClientRect = () => rect(50, 10, 400, 300);
    fireEvent.click(img, { clientX: 500, clientY: 450 }); // fx 1, fy 1, pointer (450, 440) → clamped (400, 300)
    await flush();
    expect(wrapper.scrollLeft).toBe(2600);
    expect(wrapper.scrollTop).toBe(1700);
  });

  it('an attached image opens the same overlay with its own source', async () => {
    // Invariant: the user-attachment thumbnail is an ImageZoom too: tapping it opens the overlay carrying its exact src.
    const m = new ConversationModel();
    m.apply({ kind: 'user_echo', text: 'look', userIndex: 0, attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'QkJCQg==', name: 'shot.png' }] } as any);
    const r = renderModel(m);
    await flush();
    await open(r.root);
    expect(overlay()!.querySelector('img')!.getAttribute('src')).toBe(SRC);
  });
});
