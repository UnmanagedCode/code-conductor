// The Edit conventions… dialog a project row's ⋮ opens: what it pre-checks, the
// request body a save sends, its notes, and its refusals and reopen reset.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  performProjectDelete: vi.fn(async () => {}),
  applySessionTitle: vi.fn(async () => 't'),
}));
vi.mock('@shared/capabilities', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: vi.fn(() => null),
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openEditConventionsDialog } from './api';
import { refreshProjects } from '@/app/controller';
import { held, routeFetch, type Route, type RoutedCall } from '@/test/routeFetch';
import type { Project } from '@/state/types';
import { bubbleInputs, scrollersBetween } from '@/test/scrollRegion';

const CATALOG = [
  { slug: 'design-guidelines', name: 'Design guidelines', description: 'core', builtin: true },
  { slug: 'testing-guidelines', name: 'Testing guidelines', description: 'core', builtin: true },
  { slug: 'documentation-guidelines', name: 'Documentation guidelines', description: 'core', builtin: true },
  { slug: 'plug/setup', name: 'Setup', description: 'with a setup step', plugin: 'plug', builtin: false, scaffold: 'Do the setup' },
  { slug: 'plug/other', name: 'Other', description: 'also with one', plugin: 'plug', builtin: false, scaffold: 'Do another' },
];
const INITIAL = ['plug/other', 'gone', 'design-guidelines'];
const selected = (slugs: string[]) => ({ mode: 'selected', slugs });
const PROJECT = {
  name: 'api', path: '/p/api', workspace: null, system: 'local', remoteId: null, worktrees: [],
  conventions: { mode: 'selected', slugs: INITIAL, unresolved: ['gone'] },
} as unknown as Project;
const NONE_PROJECT = { ...PROJECT, conventions: { mode: 'none', unresolved: [] } } as unknown as Project;
const URL = '/api/projects/api/conventions';
const SAVED = { json: { ok: true, path: '/p/api/CONVENTIONS.md', selection: { mode: 'unset' }, unresolved: [] } };

function stub(extra: Record<string, Route> = {}) {
  return routeFetch({
    'GET /api/settings/conventions/project': () => ({ json: { conventions: CATALOG } }),
    ...extra,
  });
}

const box = (slug: string) => document.querySelector(`[data-convention="${slug}"]`) as HTMLElement;
const checked = (slug: string) => box(slug).getAttribute('data-state') === 'checked';
const toggle = (slug: string) => fireEvent.click(box(slug));
const noneBox = () => document.querySelector('[data-no-conventions]') as HTMLElement;
const noneChecked = () => noneBox().getAttribute('data-state') === 'checked';
const toggleNone = () => fireEvent.click(noneBox());
const anyConventionChecked = () => [...document.querySelectorAll('[data-convention]')].some((b) => b.getAttribute('data-state') === 'checked');
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const save = () => fireEvent.click(saveButton());
const puts = (calls: RoutedCall[]) => calls.filter((c) => c.method === 'PUT' && c.url === URL);
const scaffoldNotes = () => [...document.querySelectorAll('[data-scaffold-note]')].map((n) => n.textContent);
const alertText = () => screen.queryByRole('alert')?.textContent ?? null;

async function open(project = PROJECT) {
  act(() => openEditConventionsDialog(project));
  await waitFor(() => expect(box('design-guidelines')).toBeTruthy());
}

afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Edit conventions dialog', () => {
  it('pre-checks the recorded selection and lists an unresolved slug, checked, under Unavailable', async () => {
    // Invariant: the boxes start as the file's selection, and a slug the catalog lacks is shown (by slug) and kept checked.
    stub();
    render(<DialogsHost />);
    await open();
    expect(['design-guidelines', 'testing-guidelines', 'documentation-guidelines', 'plug/setup', 'plug/other'].map(checked))
      .toEqual([true, false, false, false, true]);
    const legends = [...document.querySelectorAll('legend')].map((l) => l.textContent);
    expect(legends).toEqual(['Project conventions', 'plug', 'Unavailable']);
    const unavailable = [...document.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')!.textContent === 'Unavailable')!;
    expect([...unavailable.querySelectorAll('[data-convention]')].map((b) => b.getAttribute('data-convention'))).toEqual(['gone']);
    expect(unavailable.textContent).toContain('gone');
    expect(checked('gone')).toBe(true);
  });

  it('a save sends the kept selection in marker order then the new picks in display order, closes and refreshes once', async () => {
    // Invariant: the PUT body is {selection: initial kept + added in display order, expected: the recorded selection}; success closes and re-reads the list.
    const calls = stub({ [`PUT ${URL}`]: () => SAVED });
    render(<DialogsHost />);
    await open();
    toggle('plug/setup');
    toggle('testing-guidelines');
    save();
    await waitFor(() => expect(dialogStore.get().editConventions).toBeNull());
    expect(puts(calls).map((c) => c.body)).toEqual([{
      selection: selected(['plug/other', 'gone', 'design-guidelines', 'testing-guidelines', 'plug/setup']),
      expected: selected(INITIAL),
    }]);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
  });

  it('unchecking an unavailable slug drops it from the save', async () => {
    // Invariant: an unresolved slug leaves the selection only when the user unchecks it.
    const calls = stub({ [`PUT ${URL}`]: () => SAVED });
    render(<DialogsHost />);
    await open();
    toggle('gone');
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ selection: selected(['plug/other', 'design-guidelines']), expected: selected(INITIAL) });
  });

  it('a newly checked convention with a setup step shows the scaffold note; one already selected does not', async () => {
    // Invariant: the note names each newly added scaffold-bearing pick, and only while it is checked.
    stub();
    render(<DialogsHost />);
    await open();
    expect(scaffoldNotes()).toEqual([]);
    toggle('plug/other');
    toggle('plug/other');
    expect(scaffoldNotes()).toEqual([]);
    toggle('plug/setup');
    expect(scaffoldNotes()).toHaveLength(1);
    expect(scaffoldNotes()[0]).toContain('Setup');
    expect(scaffoldNotes()[0]).not.toContain('Other');
    toggle('plug/setup');
    expect(scaffoldNotes()).toEqual([]);
  });

  it('says that saving leaves CONVENTIONS.md as an uncommitted change', async () => {
    // Invariant: the dialog tells the user the save is an uncommitted change in the project tree.
    stub();
    render(<DialogsHost />);
    await open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('CONVENTIONS.md');
    expect(dialog.textContent).toContain('uncommitted');
  });

  it('Save stays disabled until the catalog loads, and while the picks equal the recorded selection', async () => {
    // Invariant: nothing can be saved from an unloaded list, nor a no-op.
    const catalog = held();
    stub({ 'GET /api/settings/conventions/project': () => catalog.answer });
    render(<DialogsHost />);
    act(() => openEditConventionsDialog(PROJECT));
    await screen.findByRole('dialog');
    expect(saveButton().disabled).toBe(true);
    await act(async () => { catalog.release({ json: { conventions: CATALOG } }); });
    await waitFor(() => expect(box('design-guidelines')).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
    toggle('testing-guidelines');
    expect(saveButton().disabled).toBe(false);
    toggle('testing-guidelines');
    expect(saveButton().disabled).toBe(true);
  });

  it('a failed catalog read shows an alert and keeps Save disabled', async () => {
    // Invariant: without a catalog the dialog cannot save, and says why.
    stub({ 'GET /api/settings/conventions/project': () => ({ status: 500, json: { error: 'catalog exploded' } }) });
    render(<DialogsHost />);
    act(() => openEditConventionsDialog(PROJECT));
    await waitFor(() => expect(alertText()).toContain('catalog exploded'));
    expect(saveButton().disabled).toBe(true);
  });

  for (const [status, error] of [[409, "the conventions of 'api' changed since they were read: now design-guidelines"], [503, 'the convention catalog is incomplete']] as const) {
    it(`a ${status} refusal shows the server's message and keeps the dialog open without refreshing`, async () => {
      // Invariant: a refused save is reported in the alert; nothing closes and the list is not re-read.
      const calls = stub({ [`PUT ${URL}`]: () => ({ status, json: { error } }) });
      render(<DialogsHost />);
      await open();
      toggle('testing-guidelines');
      save();
      await waitFor(() => expect(alertText()).toContain(error));
      expect(puts(calls)).toHaveLength(1);
      expect(dialogStore.get().editConventions).not.toBeNull();
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(refreshProjects).not.toHaveBeenCalled();
    });
  }

  it('a selection recording a slug twice opens unchanged, and a save sends it once', async () => {
    // Invariant: a repeated marker slug counts once — Save starts disabled and the PUT's selection never repeats one; expected stays the recorded marker so the server's guard matches it.
    const RECORDED = ['design-guidelines', 'design-guidelines'];
    const calls = stub({ [`PUT ${URL}`]: () => SAVED });
    render(<DialogsHost />);
    act(() => openEditConventionsDialog({ ...PROJECT, conventions: { mode: 'selected', slugs: RECORDED, unresolved: [] } } as unknown as Project));
    await waitFor(() => expect(box('design-guidelines')).toBeTruthy());
    expect(checked('design-guidelines')).toBe(true);
    expect(saveButton().disabled).toBe(true);
    toggle('testing-guidelines');
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ selection: selected(['design-guidelines', 'testing-guidelines']), expected: selected(RECORDED) });
  });

  it('reopening resets the picks, the alert and the scaffold note, and the next save carries only the new toggle', async () => {
    // Invariant: a reopen starts from the recorded selection with no leftover state; its save body is built from that reset.
    const answers: Route[] = [() => ({ status: 503, json: { error: 'catalog degraded' } }), () => SAVED];
    const calls = stub({ [`PUT ${URL}`]: (b, u) => answers.shift()!(b, u) });
    render(<DialogsHost />);
    await open();
    toggle('plug/setup');
    toggle('design-guidelines');
    save();
    await waitFor(() => expect(alertText()).toContain('catalog degraded'));
    expect(scaffoldNotes()).toHaveLength(1);
    act(() => closeDialog('editConventions'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await open();
    expect(['design-guidelines', 'testing-guidelines', 'plug/setup', 'plug/other', 'gone'].map(checked))
      .toEqual([true, false, false, true, true]);
    expect(alertText()).toBeNull();
    expect(scaffoldNotes()).toEqual([]);
    toggle('documentation-guidelines');
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1].body).toEqual({ selection: selected([...INITIAL, 'documentation-guidelines']), expected: selected(INITIAL) });
  });

  it('choosing no project conventions unticks every convention, a convention untick it, and saving it drops the kept slugs', async () => {
    // Invariant: none and any convention are mutually exclusive, and saving none sends {mode: 'none'} against the recorded selection.
    const calls = stub({ [`PUT ${URL}`]: () => SAVED });
    render(<DialogsHost />);
    await open();
    expect(noneBox()).toBeTruthy();
    expect(noneChecked()).toBe(false);
    toggleNone();
    expect(noneChecked()).toBe(true);
    expect(anyConventionChecked()).toBe(false);
    expect(checked('gone')).toBe(false);
    expect(saveButton().disabled).toBe(false);
    toggle('testing-guidelines');
    expect(noneChecked()).toBe(false);
    expect(checked('testing-guidelines')).toBe(true);
    toggleNone();
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ selection: { mode: 'none' }, expected: selected(INITIAL) });
  });

  it('a project that chose none opens with none ticked, and unticking it saves unset', async () => {
    // Invariant: the dialog opens on the recorded state and sends it as `expected`; nothing ticked without none is unset.
    const calls = stub({ [`PUT ${URL}`]: () => SAVED });
    render(<DialogsHost />);
    await open(NONE_PROJECT);
    expect(noneBox()).toBeTruthy();
    expect(noneChecked()).toBe(true);
    expect(anyConventionChecked()).toBe(false);
    expect(saveButton().disabled).toBe(true);
    toggleNone();
    expect(saveButton().disabled).toBe(false);
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ selection: { mode: 'unset' }, expected: { mode: 'none' } });
  });

  it('reopening after a refused none save starts from the recorded selection, and the next save carries only the new toggle', async () => {
    // Invariant: a reopen leaves no none tick behind; its save body is built from the reset.
    const answers: Route[] = [() => ({ status: 409, json: { error: 'changed since they were read' } }), () => SAVED];
    const calls = stub({ [`PUT ${URL}`]: (b, u) => answers.shift()!(b, u) });
    render(<DialogsHost />);
    await open();
    expect(noneBox()).toBeTruthy();
    toggleNone();
    save();
    await waitFor(() => expect(alertText()).toContain('changed since they were read'));
    act(() => closeDialog('editConventions'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await open();
    expect(noneChecked()).toBe(false);
    expect(['design-guidelines', 'testing-guidelines', 'plug/setup', 'plug/other', 'gone'].map(checked))
      .toEqual([true, false, false, true, true]);
    expect(alertText()).toBeNull();
    expect(scaffoldNotes()).toEqual([]);
    expect(saveButton().disabled).toBe(true);
    toggle('documentation-guidelines');
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1].body).toEqual({ selection: selected([...INITIAL, 'documentation-guidelines']), expected: selected(INITIAL) });
  });

  it('reopening a project that chose none ticks none again and drops the unsaved picks', async () => {
    // Invariant: a reopen restores the recorded none; a save then sends the new pick against it.
    const calls = stub({ [`PUT ${URL}`]: () => SAVED });
    render(<DialogsHost />);
    await open(NONE_PROJECT);
    expect(noneBox()).toBeTruthy();
    toggleNone();
    toggle('design-guidelines');
    act(() => closeDialog('editConventions'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await open(NONE_PROJECT);
    expect(noneChecked()).toBe(true);
    expect(anyConventionChecked()).toBe(false);
    toggleNone();
    toggle('testing-guidelines');
    save();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ selection: selected(['testing-guidelines']), expected: { mode: 'none' } });
  });

  it('the conventions list is the dialog\'s only scroller and a positioned box holding every hidden convention input; the header, footer and no-conventions choice sit outside it, and the dialog → form → list chain lets the list shrink', async () => {
    // Invariant: only the list scrolls; Radix's absolutely positioned hidden inputs of the conventions stay inside it (it is `relative`), so they cannot lengthen the dialog; the none choice is never scrolled away; the flex chain lets the list shrink below its cap.
    stub();
    render(<DialogsHost />);
    await open();
    const dialog = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
    const scrollers = scrollersBetween(box('design-guidelines'), dialog);
    expect(scrollers).toHaveLength(1);
    const list = scrollers[0];
    expect(list.classList.contains('relative')).toBe(true);
    const inputs = bubbleInputs(dialog, '[data-convention]');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs).toHaveLength(document.querySelectorAll('[data-convention]').length);
    for (const i of inputs) expect(list.contains(i)).toBe(true);
    expect(list.contains(dialog.querySelector('[data-slot="dialog-header"]'))).toBe(false);
    expect(list.contains(dialog.querySelector('[data-slot="dialog-footer"]'))).toBe(false);
    expect(noneBox()).toBeTruthy();
    expect(list.contains(noneBox())).toBe(false);
    expect(dialog.classList.contains('flex')).toBe(true);
    expect(dialog.classList.contains('flex-col')).toBe(true);
    expect(dialog.classList.contains('grid')).toBe(false);
    const form = list.parentElement as HTMLElement;
    expect(form.tagName).toBe('FORM');
    expect(form.parentElement).toBe(dialog);
    for (const c of ['flex', 'flex-col', 'min-h-0']) expect(form.classList.contains(c)).toBe(true);
  });
});
