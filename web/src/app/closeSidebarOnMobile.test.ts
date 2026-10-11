import { beforeEach, describe, expect, it } from 'vitest';
import { closeSidebarOnMobile, uiStore } from './ui';

beforeEach(() => uiStore.set({ sidebarOpen: false }));

describe('closeSidebarOnMobile', () => {
  it('collapses an open drawer', () => {
    // Invariant: navigating from the drawer closes it.
    uiStore.set({ sidebarOpen: true });
    closeSidebarOnMobile();
    expect(uiStore.get().sidebarOpen).toBe(false);
  });

  it('does nothing when the drawer is closed, so a desktop column (which never opens it) is untouched', () => {
    // Invariant: closing never writes state when there is no open drawer.
    let writes = 0;
    const off = uiStore.subscribe(() => { writes++; });
    closeSidebarOnMobile();
    off();
    expect(writes).toBe(0);
    expect(uiStore.get().sidebarOpen).toBe(false);
  });
});
