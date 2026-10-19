// The drill-in submenu below md: a submenu opens in place inside its parent
// menu instead of floating beside it. Width comes from a fake matchMedia
// (happy-dom's own viewport is 1024px and matches WIDE_QUERY).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from './dropdown-menu';

let wide = true;
let listeners = new Set<(e: { matches: boolean }) => void>();
beforeEach(() => {
  wide = true;
  listeners = new Set();
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() { return wide; },
    onchange: null,
    addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Crosses md under a mounted menu. */
function setWide(v: boolean) {
  wide = v;
  act(() => { for (const fn of [...listeners]) fn({ matches: v }); });
}

const picked: string[] = [];
beforeEach(() => { picked.length = 0; });

function Menu({ aDisabled = false }: { aDisabled?: boolean }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>One</DropdownMenuItem>
        <DropdownMenuItem>Two</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={aDisabled}>Sub A</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel>Group</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => picked.push('A1')}>A1</DropdownMenuItem>
            <DropdownMenuItem>A2</DropdownMenuItem>
            <div>A note</div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Sub B</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>B1</DropdownMenuItem>
            <DropdownMenuItem>B2</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem>Last</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function openMenu() {
  const t = screen.getByRole('button', { name: 'Open' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // let a previous close settle
    t.focus();
    fireEvent.keyDown(t, { key: 'ArrowDown' });
  });
  return screen.getByRole('menu');
}
const names = () => screen.getAllByRole('menu').flatMap((m) => [...m.querySelectorAll('[role^="menuitem"]')]).map((i) => i.textContent!.trim());
const item = (name: string) => screen.getByRole('menuitem', { name });
const ALL = ['One', 'Two', 'Sub A', 'Sub B', 'Last'];

describe('narrow: a submenu drills in', () => {
  beforeEach(() => { wide = false; });

  it.each(['click', 'Enter'] as const)('%s on a submenu row replaces the parent items with the submenu in the same single menu', async (how) => {
    // Invariant: below md activating a sub trigger leaves exactly one menu holding only [trigger, ...sub items] (sub-only notes kept, parent items, other triggers and separators gone), the trigger reading aria-expanded=true and, by keyboard, keeping focus.
    render(<Menu />);
    await openMenu();
    expect(names()).toEqual(ALL);
    const trigger = item('Sub A');
    trigger.focus();
    await act(async () => { if (how === 'click') fireEvent.click(trigger); else fireEvent.keyDown(trigger, { key: 'Enter' }); });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(names()).toEqual(['Sub A', 'A1', 'A2']);
    expect(item('Sub A').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('A note')).toBeTruthy();
    expect(screen.getByText('Group')).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
    if (how === 'Enter') expect(document.activeElement === item('Sub A')).toBe(true);
  });

  it('the back row restores the parent items; the same node keeps focus and reads collapsed', async () => {
    // Invariant: activating the drilled trigger restores the full item list and the trigger node is the same element, still focused, with aria-expanded=false.
    render(<Menu />);
    await openMenu();
    const trigger = item('Sub A');
    trigger.focus();
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }); });
    await act(async () => { fireEvent.keyDown(item('Sub A'), { key: 'Enter' }); });
    expect(names()).toEqual(ALL);
    expect(item('Sub A') === trigger).toBe(true);
    expect(document.activeElement === trigger).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('picking a submenu item fires its onSelect once and closes the menu; a reopened menu is undrilled', async () => {
    // Invariant: a drilled pick selects exactly once, closes the menu, and drill state does not survive the close.
    render(<Menu />);
    await openMenu();
    await act(async () => { fireEvent.click(item('Sub A')); });
    expect(names()).toEqual(['Sub A', 'A1', 'A2']);
    await act(async () => { fireEvent.click(item('A1')); });
    expect(picked).toEqual(['A1']);
    expect(screen.queryAllByRole('menu')).toEqual([]);
    await openMenu();
    expect(names()).toEqual(ALL);
  });

  it('a submenu whose trigger turns disabled while drilled keeps an enabled back row', async () => {
    // Invariant: the way back is never disabled, whatever the caller does to the trigger's disabled prop.
    const r = render(<Menu />);
    await openMenu();
    await act(async () => { fireEvent.click(item('Sub A')); });
    r.rerender(<Menu aDisabled />);
    expect(item('Sub A').hasAttribute('data-disabled')).toBe(false);
    await act(async () => { fireEvent.click(item('Sub A')); });
    expect(names()).toEqual(ALL);
    expect(item('Sub A').hasAttribute('data-disabled')).toBe(true);
  });

  it('crossing md while drilled falls back to the cascade, and the drill is kept when narrow again', async () => {
    // Invariant: widening shows the parent items with a floating-sub trigger (aria-haspopup=menu); narrowing again reads drilled again (the drill state is kept, not reset).
    render(<Menu />);
    await openMenu();
    await act(async () => { fireEvent.click(item('Sub A')); });
    setWide(true);
    expect(names()).toEqual(ALL);
    expect(item('Sub A').getAttribute('aria-haspopup')).toBe('menu');
    setWide(false);
    expect(names()).toEqual(['Sub A', 'A1', 'A2']);
  });
});

describe('wide: the cascade is unchanged', () => {
  it('ArrowRight on a submenu trigger opens a second menu beside the parent, whose items stay', async () => {
    // Invariant: from md up a sub trigger opens a second role=menu holding the sub items while the parent keeps its own.
    render(<Menu />);
    await openMenu();
    await act(async () => { fireEvent.keyDown(item('Sub A'), { key: 'ArrowRight' }); });
    const menus = screen.getAllByRole('menu');
    expect(menus).toHaveLength(2);
    expect([...menus[1].querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent)).toEqual(['A1', 'A2']);
    expect(names()).toEqual(expect.arrayContaining(['One', 'Two', 'Sub A', 'Sub B', 'Last']));
  });
});
