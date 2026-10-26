// The worker-identity cue in the session header: the owner chip (also the way back to the owner),
// the unknown-owner chip, and the Alt+ArrowUp shortcut.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => undefined }));
vi.mock('@/app/controller', async (orig) => ({ ...(await orig<typeof import('@/app/controller')>()), selectInstance: vi.fn() }));
vi.mock('@/app/sessionActions', async (orig) => ({ ...(await orig<typeof import('@/app/sessionActions')>()), resumeSession: vi.fn(), respawnActive: vi.fn(), syncWorktree: vi.fn() }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { selectInstance } from '@/app/controller';
import { resumeSession } from '@/app/sessionActions';
import { conductorColor } from '@shared/conductorColor';
import { CONDUCT_PROJECT } from '@shared/conductors';
import { C1, C1_LABEL, C2, C2_LABEL, CI, CI_LABEL, CGONE, seedWorkerFleet, type Fleet } from '@/test/workerFleet';
import { SessionHeader } from './SessionHeader';

let f: Fleet;
beforeEach(() => {
  vi.mocked(selectInstance).mockClear();
  vi.mocked(resumeSession).mockClear();
  f = seedWorkerFleet();
});
afterEach(() => vi.unstubAllGlobals());

const show = (inst: any) => render(<TooltipProvider><SessionHeader inst={inst} onMenu={() => {}} /></TooltipProvider>);
const chip = () => document.querySelector('[data-owner-chip]') as HTMLElement | null;
const back = (label: string) => screen.queryByRole('button', { name: `Back to ${label}` });
const altUp = (target: Window | Element = window) => fireEvent.keyDown(target, { key: 'ArrowUp', altKey: true });

describe('owner chip', () => {
  it('W1 shows `Back to <C1 label>` with --owner-color = conductorColor(C1); W2 shows C2\'s colour', () => {
    show(f.w1);
    expect(back(C1_LABEL)).not.toBeNull();
    expect(chip()!.style.getPropertyValue('--owner-color')).toBe(conductorColor(C1));
    cleanup();
    show(f.w2);
    expect(back(C2_LABEL)).not.toBeNull();
    expect(chip()!.style.getPropertyValue('--owner-color')).toBe(conductorColor(C2));
    expect(conductorColor(C1)).not.toBe(conductorColor(C2));
  });

  // Invariant: a conducted conductor-project session (a section lead) renders no owner chip.
  it('a conducted conductor-project session with an owner shows no chip', () => {
    const lead = { ...f.c2, conducted: true, ownerSessionId: C1 };
    show({ ...lead, project: 'other-project' });
    expect(chip()).not.toBeNull(); // premise: only the project differs
    cleanup();
    show(lead);
    expect(chip()).toBeNull();
  });

  it('C1, H show no chip; WU shows `Conducted worker` and no Back button; WA shows the chip with no button', () => {
    show(f.w1);
    expect(chip()).not.toBeNull(); // premise: this render path does show one
    for (const i of [f.c1, f.h]) {
      cleanup();
      show(i);
      expect(chip()).toBeNull();
    }
    cleanup();
    show(f.wu);
    expect(chip()?.textContent).toContain('Conducted worker');
    expect(chip()?.getAttribute('data-owner-chip')).toBe('unknown');
    expect(screen.queryAllByRole('button', { name: /^Back to/ })).toHaveLength(0);
    expect(chip()!.style.getPropertyValue('--owner-color')).toBe('');
    cleanup();
    show(f.wa);
    expect(chip()).not.toBeNull();
    expect(chip()!.tagName).not.toBe('BUTTON');
    expect(chip()!.style.getPropertyValue('--owner-color')).toBe(conductorColor(CGONE));
    expect(screen.queryAllByRole('button', { name: /^Back to/ })).toHaveLength(0);
  });

  it('a worker with no title and no worktree still renders line 2 with the chip', () => {
    show({ ...f.w1, title: undefined, worktree: null });
    expect(back(C1_LABEL)).not.toBeNull();
  });

  it('clicking the chip selects C1 with {push, userGesture}; for WI it resumes CI in .conduct', () => {
    show(f.w1);
    expect(back(C1_LABEL)).not.toBeNull();
    fireEvent.click(back(C1_LABEL)!);
    expect(vi.mocked(selectInstance).mock.calls).toEqual([[f.c1.id, { push: true, userGesture: true }]]);
    expect(resumeSession).not.toHaveBeenCalled();
    cleanup();
    show(f.wi);
    expect(back(CI_LABEL)).not.toBeNull();
    fireEvent.click(back(CI_LABEL)!);
    expect(vi.mocked(resumeSession).mock.calls).toEqual([[{ projectName: CONDUCT_PROJECT, worktreeName: null, sessionId: CI }]]);
    expect(vi.mocked(selectInstance)).toHaveBeenCalledTimes(1);
  });

  it('under a narrow matchMedia (below WIDE_QUERY) the chip still renders', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: false, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true,
    }));
    show(f.w1);
    expect(back(C1_LABEL)).not.toBeNull();
  });
});

describe('Alt+ArrowUp', () => {
  it('on window or the textarea selects the owner; inside an open Session-actions menu it does not; after unmount it does not', async () => {
    const r = show(f.w1);
    altUp();
    expect(vi.mocked(selectInstance).mock.calls).toEqual([[f.c1.id, { push: true, userGesture: true }]]);
    const ta = document.createElement('textarea');
    document.body.append(ta);
    altUp(ta);
    expect(selectInstance).toHaveBeenCalledTimes(2);
    ta.remove();

    const trigger = screen.getByRole('button', { name: 'Session actions' });
    await act(async () => { trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); });
    const menu = screen.getByRole('menu');
    altUp(menu);
    expect(selectInstance).toHaveBeenCalledTimes(2);

    r.unmount();
    altUp();
    expect(selectInstance).toHaveBeenCalledTimes(2);
  });

  it('is inert for a conductor, a hand session, an unknown owner and an unlisted owner', () => {
    show(f.w1);
    altUp();
    expect(selectInstance).toHaveBeenCalledTimes(1); // premise: the listener is live here
    for (const i of [f.c1, f.h, f.wu, f.wa]) {
      cleanup();
      show(i);
      altUp();
    }
    expect(selectInstance).toHaveBeenCalledTimes(1);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('resumes an inactive listed conductor owner', () => {
    show(f.wi);
    altUp();
    expect(vi.mocked(resumeSession).mock.calls).toEqual([[{ projectName: CONDUCT_PROJECT, worktreeName: null, sessionId: CI }]]);
  });
});
