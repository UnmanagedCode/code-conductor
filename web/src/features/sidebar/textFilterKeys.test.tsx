// The filter's keyboard contract: `/` takes the input from anywhere that is not text entry, Esc clears and
// blurs it without anything else (a view's Escape handler, the drawer) reacting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { uiStore } from '@/app/ui';
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

  it('does nothing while a dialog outside the sidebar is open', () => {
    // Pins: the shortcut never reaches past an open dialog.
    renderSidebar();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    append(dialog);
    expect(press(document.body, { key: '/' })).toBe(true);
    expect(document.activeElement).not.toBe(filterInput());
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

describe('in the phone drawer', () => {
  it('the first Esc clears the input without closing the drawer, and the next Esc closes it', async () => {
    // Pins (a decision): Esc in the drawer's input only clears; a second Esc dismisses the drawer as before.
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <Sheet open onOpenChange={onOpenChange}>
          <SheetContent side="left" onEscapeKeyDown={keepFilterEscape}>
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
