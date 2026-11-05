import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockMode } from './dockLayout';

const KEY = 'code-conductor:session-column';
const ATTR = 'data-cc-session-width';
const published = () => document.documentElement.getAttribute(ATTR);

async function boot(stored?: string) {
  vi.resetModules();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  const { startPluginSessionWidth } = await import('./pluginSessionWidth');
  const width = await import('@/app/sessionWidth');
  const { dockModeStore } = await import('./dock');
  startPluginSessionWidth();
  return { ...width, mode: (mode: DockMode) => dockModeStore.set({ mode }) };
}

const RESIZABLE = JSON.stringify({ width: 896, full: false });
const FULL = JSON.stringify({ width: 896, full: true });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(ATTR);
});

describe('startPluginSessionWidth', () => {

  it('publishes the stored setting at start', async () => {
    // Invariant: the attribute is present synchronously at start, as <n>px.
    await boot(JSON.stringify({ width: 896, full: false }));
    expect(published()).toBe('896px');
  });

  it('publishes the default for an unreadable stored value', async () => {
    // Invariant: parsing and clamping come from the setting's own module.
    await boot('garbage');
    expect(published()).toBe('768px');
  });

  it('republishes on every committed change', async () => {
    // Invariant: width, Full and reset each reach the attribute.
    const w = await boot(JSON.stringify({ width: 896, full: false }));
    w.setSessionWidth(1024);
    expect(published()).toBe('1024px');
    w.setSessionFull(true);
    expect(published()).toBe('none');
    w.setSessionFull(false);
    w.resetSessionWidth();
    expect(published()).toBe('768px');
  });

  it('does not publish a live drag width', async () => {
    // Invariant: the publisher performs no write when only the drag store changes (no per-pointermove churn).
    const w = await boot(JSON.stringify({ width: 896, full: false }));
    const write = vi.spyOn(document.documentElement, 'setAttribute');
    w.sessionWidthDragStore.set({ live: 1500 });
    expect(write, 'a drag-store change performs no write on <html>').not.toHaveBeenCalled();
    expect(published()).toBe('896px');
    write.mockRestore();
  });
});

describe('in the side pane', () => {
  it('a page in split is told none under Resizable, and the setting\'s changes leave it none', async () => {
    // Invariant: the split pane never caps its page, whatever the committed width.
    const w = await boot(RESIZABLE);
    w.mode('split');
    expect(published()).toBe('none');
    w.setSessionWidth(1024);
    expect(published(), 'a width change while split').toBe('none');
    w.setSessionFull(true);
    w.setSessionFull(false);
    expect(published(), 'Full and back while split').toBe('none');
  });

  it('a page in split is told none under Full', async () => {
    // Invariant: the split pane's value does not depend on the Full flag either.
    const w = await boot(FULL);
    w.mode('split');
    expect(published()).toBe('none');
  });

  it('a page in the rail is told none under Resizable, and the setting\'s changes leave it none', async () => {
    // Invariant: the collapsed split (rail) keeps the pane's value, so a parked page is not resized.
    const w = await boot(RESIZABLE);
    w.mode('rail');
    expect(published()).toBe('none');
    w.setSessionWidth(1024);
    expect(published(), 'a width change while in the rail').toBe('none');
  });

  it('a page in the rail is told none under Full', async () => {
    // Invariant: the rail's value does not depend on the Full flag.
    const w = await boot(FULL);
    w.mode('rail');
    expect(published()).toBe('none');
  });

  it('the full view follows the setting', async () => {
    // Invariant: the whole-row column publishes the committed setting, live (regression guard for today's behaviour).
    const w = await boot(RESIZABLE);
    w.mode('full');
    expect(published()).toBe('896px');
    w.setSessionFull(true);
    expect(published()).toBe('none');
    w.setSessionFull(false);
    expect(published()).toBe('896px');
  });

  it('docking and expanding republish live', async () => {
    // Invariant: a mode change alone republishes, with no setting change.
    const w = await boot(RESIZABLE);
    w.mode('full');
    expect(published(), 'full').toBe('896px');
    w.mode('split');
    expect(published(), 'docked').toBe('none');
    w.mode('full');
    expect(published(), 'expanded').toBe('896px');
  });

  it('a hidden column keeps the context its page was last shown in', async () => {
    // Invariant: hidden never flips the value; a page hidden from split stays none, one hidden from full keeps following the setting.
    const w = await boot(RESIZABLE);
    w.mode('split');
    w.mode('hidden');
    w.setSessionWidth(1024);
    expect(published(), 'hidden after split').toBe('none');
    w.mode('full');
    expect(published(), 'full').toBe('1024px');
    w.mode('hidden');
    expect(published(), 'hidden after full').toBe('1024px');
    w.setSessionFull(true);
    expect(published(), 'Full while hidden after full').toBe('none');
    w.setSessionFull(false);
    expect(published(), 'Resizable while hidden after full').toBe('1024px');
  });
});
