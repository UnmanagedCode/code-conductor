import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { selectOptions } from '@/test/radixSelect';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('@/features/sidebar/AppSidebar');
const { AppSwitcher } = await import('@/features/views/AppSwitcher');
const { catalogStore } = await import('@/features/views/plugins');
const { UsageChip } = await import('@/features/session/UsageChip');
const { SessionHeader } = await import('@/features/session/SessionHeader');

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const wrap = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
const press = (el: Element) => act(async () => {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
  fireEvent.pointerUp(el, { button: 0 });
  fireEvent.click(el);
});
const escape = (el: Element | null) => act(async () => { fireEvent.keyDown(el ?? document.body, { key: 'Escape' }); });

/** One popover/menu kind: how to open it, whether it is open, the open surface, and what a press outside is. */
type Kind = { open: () => Promise<void>; isOpen: () => boolean; surface: () => HTMLElement };

async function dismissesOnOutsidePressAndEscape(k: Kind) {
  await k.open();
  expect(k.isOpen(), 'opened').toBe(true);
  await press(document.body);
  expect(k.isOpen(), 'a press outside').toBe(false);

  await k.open();
  expect(k.isOpen(), 'reopened').toBe(true);
  await escape(k.surface());
  expect(k.isOpen(), 'Escape').toBe(false);
}

const inst = (o: Record<string, any> = {}) => ({ id: 'inst-1', sessionId: 'sess-1', project: 'p', status: 'idle', displayStatus: 'idle', mode: 'plan', ...o }) as any;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  uiStore.set({ lens: 'conductors', sidebarOpen: false });
  catalogStore.set({ apps: [] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) })));
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});

describe('popovers and menus dismiss on an outside press and on Escape', () => {
  it('a non-modal dropdown menu (the sidebar project-actions menu)', async () => {
    // Invariant: the ≡ menu closes on a press outside and on Escape.
    wrap(<AppSidebar />);
    const trigger = () => screen.getByRole('button', { name: 'Project actions' });
    await dismissesOnOutsidePressAndEscape({
      open: async () => { await settle(); await act(async () => { trigger().focus(); fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); }); await settle(); },
      isOpen: () => screen.queryAllByRole('menu').length > 0,
      surface: () => screen.getByRole('menu'),
    });
  });

  it('a non-modal dropdown menu (the session header actions menu)', async () => {
    // Invariant: the ⋮ menu closes on a press outside and on Escape.
    wrap(<SessionHeader inst={inst()} onMenu={() => {}} />);
    const trigger = () => screen.getByRole('button', { name: 'Session actions' });
    await dismissesOnOutsidePressAndEscape({
      open: async () => { await settle(); await act(async () => { trigger().focus(); fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); }); await settle(); },
      isOpen: () => screen.queryAllByRole('menu').length > 0,
      surface: () => screen.getByRole('menu'),
    });
  });

  it('a modal dropdown menu (the app switcher)', async () => {
    // Invariant: the Conductor / plugin switcher closes on a press outside and on Escape.
    catalogStore.set({ apps: [{ id: 'fake-plugin', name: 'Fake', enabled: true, hasFrontend: true }] });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rows: [{ id: 'fake-plugin', name: 'Fake', enabled: true, hasFrontend: true }] }) })));
    wrap(<AppSwitcher slot="sidebar" title="Code Conductor" fallback={null} />);
    const trigger = () => screen.getByRole('button', { name: 'Switch app' });
    await settle();
    await dismissesOnOutsidePressAndEscape({
      open: async () => { await settle(); await act(async () => { trigger().focus(); fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); }); await settle(); },
      isOpen: () => screen.queryAllByRole('menu').length > 0,
      surface: () => screen.getByRole('menu'),
    });
  });

  it('a popover (the usage details chip)', async () => {
    // Invariant: the usage popover closes on a press outside and on Escape, and a press inside it does not close it.
    wrap(<UsageChip inst={inst({ contextWindowTokens: 200_000 })} />);
    const trigger = () => screen.getByRole('button', { name: 'Usage details' });
    const surface = () => document.querySelector('[data-slot="popover-content"]') as HTMLElement;
    const k: Kind = {
      open: async () => { await act(async () => { fireEvent.click(trigger()); }); await settle(); },
      isOpen: () => trigger().getAttribute('aria-expanded') === 'true',
      surface,
    };
    await k.open();
    await press(surface());
    expect(k.isOpen(), 'a press inside').toBe(true);
    await press(document.body);
    expect(k.isOpen(), 'a press outside').toBe(false);
    await k.open();
    await escape(surface());
    expect(k.isOpen(), 'Escape').toBe(false);
  });

  it('a select list (the conductor filter)', async () => {
    // Invariant: the filter's option list closes on a press outside and on Escape, choosing nothing.
    uiStore.set({ lens: 'projects' });
    wrap(<AppSidebar />);
    const trigger = () => screen.getByRole('combobox', { name: 'Filter by conductor' });
    await dismissesOnOutsidePressAndEscape({
      open: async () => { selectOptions(trigger()); await settle(); },
      isOpen: () => screen.queryAllByRole('listbox').length > 0,
      surface: () => screen.getByRole('listbox'),
    });
  });

  it('a dialog', async () => {
    // Invariant: a dialog closes on a press on its backdrop and on Escape, and a press inside does not close it.
    function Host() {
      const [open, setOpen] = React.useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent><DialogTitle>Title</DialogTitle><DialogDescription>Body</DialogDescription><button>inner</button></DialogContent>
        </Dialog>
      );
    }
    const mount = () => render(<Host />);
    let r = mount();
    await settle();
    await press(screen.getByRole('button', { name: 'inner' }));
    expect(screen.queryByRole('dialog'), 'a press inside').not.toBeNull();
    await press(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(screen.queryByRole('dialog'), 'a press outside').toBeNull();
    r.unmount();
    r = mount();
    await settle();
    await escape(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog'), 'Escape').toBeNull();
  });

  it('a sheet (the phone drawer)', async () => {
    // Invariant: the drawer closes on a press on its scrim and on Escape.
    function Host() {
      const [open, setOpen] = React.useState(true);
      return (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left"><SheetTitle>Navigation</SheetTitle><SheetDescription>Menu</SheetDescription><button>inner</button></SheetContent>
        </Sheet>
      );
    }
    const mount = () => render(<Host />);
    let r = mount();
    await settle();
    await press(screen.getByRole('button', { name: 'inner' }));
    expect(screen.queryByRole('dialog'), 'a press inside').not.toBeNull();
    await press(document.querySelector('[data-slot="sheet-overlay"], .bg-black\\/40')!);
    expect(screen.queryByRole('dialog'), 'a press outside').toBeNull();
    r.unmount();
    r = mount();
    await settle();
    await escape(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog'), 'Escape').toBeNull();
  });
});
