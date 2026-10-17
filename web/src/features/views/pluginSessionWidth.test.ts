import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'code-conductor:session-column';
const ATTR = 'data-cc-session-width';
const published = () => document.documentElement.getAttribute(ATTR);

async function boot(stored?: string) {
  vi.resetModules();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  const { startPluginSessionWidth } = await import('./pluginSessionWidth');
  const width = await import('@/app/sessionWidth');
  startPluginSessionWidth();
  return width;
}

describe('startPluginSessionWidth', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(ATTR);
  });

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
