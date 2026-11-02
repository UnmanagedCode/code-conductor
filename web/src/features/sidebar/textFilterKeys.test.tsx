// The filter's keyboard contract: `/` takes the input from anywhere that is not text entry, Esc clears and
// blurs it without anything else (a view's Escape handler, the drawer) reacting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { uiStore } from '@/app/ui';
import { focusContent } from '@/lib/modalFocus';
import { seed } from '@/test/sidebarFleet';
import { filterInput, typeFilter } from '@/test/textFilter';

vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn() }));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { keepFilterEscape } = await import('./FilterBar');
const { resetTextFilter, textFilterStore } = await import('./textFilterState');
const { resetSessionSearch } = await import('./sessionSearch');
const { invalidateSessions } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** A keydown on `target`; returns whether it was left unprevented. */
const press = (target: Element, init: KeyboardEventInit) => fireEvent.keyDown(target, init);

beforeEach(() => {
  localStorage.clear();
  invalidateSessions();
  resetTextFilter();
  resetSessionSearch();
  seed({ projects: [], workspaces: [], instances: [] });
  uiStore.set({ lens: 'projects' });
});
/** Elements a test appended to the page itself. */
const appended: Element[] = [];
afterEach(() => { for (const e of appended.splice(0)) e.remove(); });
const append = (e: Element) => { document.body.append(e); appended.push(e); };

describe('/', () => {
  it('on the page body focuses the input, is prevented, and types nothing', () => {
    // Pins: the shortcut moves focus without inserting its own character.
    renderSidebar();
    const unprevented = press(document.body, { key: '/' });
    expect(unprevented).toBe(false);
    expect(document.activeElement).toBe(filterInput());
    expect(filterInput().value).toBe('');
  });

  it.each([
    ['textarea', () => document.createElement('textarea')],
    ['input', () => document.createElement('input')],
    ['contenteditable', () => { const d = document.createElement('div'); d.setAttribute('contenteditable', 'true'); d.tabIndex = 0; return d; }],
  ])('while focus is in a %s it is left alone', (_name, make) => {
    // Pins: typing a slash into any text-entry field is never hijacked.
    renderSidebar();
    const field = make();
    append(field);
    field.focus();
    expect(press(field, { key: '/' })).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it.each([['ctrlKey'], ['metaKey'], ['altKey']])('with %s held it is ignored', (mod) => {
    // Pins: a chord is not the shortcut.
    renderSidebar();
    expect(press(document.body, { key: '/', [mod]: true })).toBe(true);
    expect(document.activeElement).not.toBe(filterInput());
  });

  it('on the Conductors tab switches to Projects and focuses the input', async () => {
    // Pins (a decision): the input exists only on Projects, so the shortcut brings the tab to it.
    uiStore.set({ lens: 'conductors' });
    renderSidebar();
    expect(filterInput()).toBeNull();
    await act(async () => { press(document.body, { key: '/' }); });
    expect(uiStore.get().lens).toBe('projects');
    expect(document.activeElement).toBe(filterInput());
  });

  it.each([['dialog'], ['menu']])('does nothing while a %s outside the sidebar is open', (role) => {
    // Pins: the shortcut never reaches past an open dialog or menu.
    renderSidebar();
    const layer = document.createElement('div');
    layer.setAttribute('role', role);
    layer.setAttribute('data-state', 'open');
    append(layer);
    expect(press(document.body, { key: '/' })).toBe(true);
    expect(document.activeElement).not.toBe(filterInput());
  });

  it('ignores a keydown something else already prevented', () => {
    // Pins: a prevented `/` belongs to whoever prevented it.
    renderSidebar();
    const claim = (e: Event) => e.preventDefault();
    document.addEventListener('keydown', claim);
    try {
      expect(press(document.body, { key: '/' })).toBe(false);
      expect(document.activeElement).not.toBe(filterInput());
    } finally { document.removeEventListener('keydown', claim); }
  });

  it('is not taken by the desktop copy while the viewport is below the wide breakpoint', () => {
    // Pins: only the shown copy acts; the desktop column, hidden below `md`, never takes the shortcut.
    const narrow = vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => (
      { matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    try {
      renderSidebar();
      expect(press(document.body, { key: '/' })).toBe(true);
      expect(document.activeElement).not.toBe(filterInput());
    } finally { narrow.mockRestore(); }
  });
});

describe('Esc in the input', () => {
  it('clears the query, blurs the input, and is prevented before a window listener sees it', async () => {
    // Pins: Esc is consumed by the filter, so a view's window-level Escape handler skips it.
    renderSidebar();
    await typeFilter('abc');
    filterInput().focus();
    const seen: boolean[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
    window.addEventListener('keydown', listener);
    press(filterInput(), { key: 'Escape' });
    window.removeEventListener('keydown', listener);
    expect(textFilterStore.get().query).toBe('');
    expect(filterInput().value).toBe('');
    expect(document.activeElement).not.toBe(filterInput());
    expect(seen).toEqual([true]);
  });
});

describe('keepFilterEscape', () => {
  it('prevents an Escape whose target is the filter input, and no other', () => {
    // Pins: the drawer guard acts only for the filter field.
    renderSidebar();
    const outside = document.createElement('button');
    append(outside);
    const prevented = (target: Element) => {
      let result = false;
      const listener = (e: KeyboardEvent) => { keepFilterEscape(e); result = e.defaultPrevented; };
      document.addEventListener('keydown', listener);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      document.removeEventListener('keydown', listener);
      return result;
    };
    expect(prevented(filterInput())).toBe(true);
    expect(prevented(outside)).toBe(false);
  });
});

describe('in the phone drawer', () => {
  it('the first Esc clears the input without closing the drawer, and the next Esc closes it', async () => {
    // Pins (a decision): Esc in the drawer's input only clears; a second Esc dismisses the drawer as before.
    // Mounted as App mounts it, with `focusContent`: opening on the first control would open its tooltip, and an
    // open tooltip is the topmost layer that takes the first Escape, so the guard would never be exercised.
    // Without `keepFilterEscape` Radix's capture-phase listener on the document dismisses on that first Escape.
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <Sheet open onOpenChange={onOpenChange}>
          <SheetContent side="left" onOpenAutoFocus={focusContent} onEscapeKeyDown={keepFilterEscape}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <AppSidebar mobile />
          </SheetContent>
        </Sheet>
      </TooltipProvider>,
    );
    await typeFilter('abc');
    filterInput().focus();
    press(filterInput(), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(textFilterStore.get().query).toBe('');
    press(document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
