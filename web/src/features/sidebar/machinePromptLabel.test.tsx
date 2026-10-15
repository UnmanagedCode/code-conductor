import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { conductor, conductorOpenOf, conductorRowOf, hand, labelOf, openOf, proj, seed, stripEntryOf, stripLabelOf, worker } from '@/test/sidebarFleet';
import { selectOptions } from '@/test/radixSelect';
import { buildWakeStub } from '@shared/wakeCallback';
import { buildForwardFrame } from '@shared/forwardFrame';
import { buildRenewSeed } from '@shared/renewSeed';
import { readJsonl } from '@/conversation/testkit';
import { firstPromptHead } from '@shared/promptPreview';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A first prompt as the server stores it: its head, cut by `Instance.prompt` and `readFirstPrompt`. */
const stored = firstPromptHead;
const WAKE = stored(buildWakeStub({ targetSessionId: 'labelwake', payloadText: '{"sessionId":"labelwake"}\nWAKE-LABEL prose' }));
const FORWARD_RAW = buildForwardFrame({ messages: ['FWD-LABEL body'], instruction: 'FWD-LABEL instruction' });
const FORWARD = stored(FORWARD_RAW);
/** A forward stored before the tail was kept: the raw frame's head, cut inside its header. */
const FORWARD_PRE_TAIL = FORWARD_RAW.slice(0, 200);
const RENEW = stored(buildRenewSeed({ summary: 'RENEW-LABEL summary' }));
/**
 * A post-`/clear` file's head record, as the server stores it: the first user record whose content starts with `head`.
 * `RENEW_HEAD` in `tests/segmentChain.mjs` models that head (importing it loads the server); this hand-authored
 * fixture carries the same caveat record and `/clear` line, the latter differing only in indentation.
 */
const renewHead = (head: string) => {
  const rec = readJsonl('awaiting-user/renew-two-segments.transcript.jsonl')
    .find((r) => r.type === 'user' && typeof r.message?.content === 'string' && r.message.content.startsWith(head));
  if (!rec) throw new Error(`fixture: no user record starting ${head}`);
  return stored(rec.message.content as string);
};
const CAVEAT = renewHead('<local-command-caveat>');
const CLEAR = renewHead('<command-name>/clear</command-name>');
/** Another local command's line, in the CLI's own shape. */
const COMPACT = stored(readJsonl('compaction-manual.transcript.jsonl')
  .find((r) => r.type === 'user' && typeof r.message?.content === 'string' && r.message.content.startsWith('<command-name>/compact</command-name>'))!.message.content);
/** A person's first prompt, and the label it has always had (whitespace collapsed). */
const HUMAN = 'human:   tidy the\n docs index';
const HUMAN_LABEL = 'human: tidy the docs index';

/** The meaningful head of the wake stub's label. */
const WAKE_LABEL = 'Wake: Worker `labelwake` finished its turn.';
/** Raw machine-prompt syntax no label may carry: the marker, and the forward frame's header. */
const RAW = /\[\[cc:|FORWARDED WORKER OUTPUT/;

/** The buttons whose accessible name contains `text`. */
const named = (text: string) => screen.getAllByRole('button', { name: (n) => n.includes(text) });
const rawNamed = () => screen.queryAllByRole('button', { name: (n) => RAW.test(n) });

beforeEach(() => {
  localStorage.clear();
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'projects' });
  seed();
});

describe('a machine-written first prompt in a sidebar label', () => {
  it('a conductor whose first prompt is a wake stub reads its wake summary, and no button is named with the marker', async () => {
    // Invariant: the Conductors-lens row's text and accessible name carry the wake summary, never the marker.
    uiStore.set({ lens: 'conductors' });
    seed({
      instances: [conductor('cond-wake', { temp: false, firstPrompt: WAKE })],
      conductSessions: [{ sessionId: 'cond-wake', firstPrompt: WAKE, lastActivity: 1 }],
    });
    renderSidebar();
    await settle();
    expect(conductorRowOf('cond-wake').textContent).toContain(WAKE_LABEL);
    expect(conductorRowOf('cond-wake').textContent).not.toMatch(RAW);
    expect(named(WAKE_LABEL).includes(conductorOpenOf('cond-wake'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a needs-you entry for a hand-spawned session whose first prompt is a wake stub carries the wake summary and no marker in its label or accessible name', async () => {
    // Invariant: the strip entry's visible label, aria-label and tooltip render the wake stub by its summary.
    seed({ projects: [proj('labels')], instances: [hand('h-wake', 'labels', null, { firstPrompt: WAKE })] });
    renderSidebar();
    await settle();
    expect(stripLabelOf('h-wake')!.textContent).toMatch(/^Wake: Worker `labelwake` finished its turn\./);
    expect(stripEntryOf('h-wake').title).not.toMatch(RAW);
    expect(named(WAKE_LABEL).includes(stripEntryOf('h-wake'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a Projects-lens session row whose first prompt is a wake stub reads its wake summary, with no marker in its label, tooltip or accessible name', async () => {
    // Invariant: sessionLabel renders the wake stub by its summary; a titled row's tooltip preview does too.
    seed({
      projects: [proj('labels')],
      instances: [
        hand('h-wake', 'labels', null, { firstPrompt: WAKE }),
        hand('h-wake-titled', 'labels', null, { firstPrompt: WAKE, title: 'Titled wake' }),
      ],
    });
    renderSidebar();
    await settle();
    expect(labelOf('h-wake').textContent).toMatch(/^Wake: Worker `labelwake` finished its turn\./);
    // Named before the preview's cut: the window holds summary text past the raw stub's first 80 chars.
    expect(labelOf('h-wake').textContent).toContain('folded in');
    expect(named(WAKE_LABEL).includes(openOf('h-wake'))).toBe(true);
    expect(labelOf('h-wake-titled').textContent).toBe('Titled wake');
    expect(openOf('h-wake-titled').title).toContain(WAKE_LABEL);
    expect(openOf('h-wake-titled').title).not.toMatch(RAW);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a session row whose first prompt is a forward frame reads its instruction\'s first line', async () => {
    // Invariant: the forward is read off the tail the server stores (END marker + instruction), by its instruction, with no frame syntax.
    seed({ projects: [proj('labels')], instances: [hand('h-fwd', 'labels', null, { firstPrompt: FORWARD })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-fwd').textContent).toBe('FWD-LABEL instruction');
    expect(named('FWD-LABEL instruction').includes(openOf('h-fwd'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a session row whose first prompt is a forward stored before its tail was kept reads Forwarded worker output', async () => {
    // Invariant: a head cut inside the forward header is still recognised, by name.
    seed({ projects: [proj('labels')], instances: [hand('h-fwd-old', 'labels', null, { firstPrompt: FORWARD_PRE_TAIL })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-fwd-old').textContent).toBe('Forwarded worker output');
    expect(named('Forwarded worker output').includes(openOf('h-fwd-old'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a session row whose first prompt is a renew seed reads Context renewed', async () => {
    // Invariant: the renew seed is recognised on the server's stored cut, which ends inside its preamble.
    seed({ projects: [proj('labels')], instances: [hand('h-renew', 'labels', null, { firstPrompt: RENEW })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-renew').textContent).toBe('Context renewed');
    expect(named('Context renewed').includes(openOf('h-renew'))).toBe(true);
    expect(screen.queryAllByRole('button', { name: (n) => n.includes('Your context was just renewed') })).toHaveLength(0);
  });

  it('the conductor filter names a hand-spawned owner whose first prompt is a wake stub by its wake summary', async () => {
    // Invariant: ownerLabel's live-instance branch renders the wake stub by its summary.
    seed({
      projects: [proj('labels')],
      instances: [hand('h-owner', 'labels', null, { firstPrompt: WAKE }), worker('w-owned', 'h-owner', 'labels')],
    });
    renderSidebar();
    await settle();
    selectOptions(screen.getByRole('combobox', { name: 'Filter by conductor' }));
    expect(screen.getAllByRole('option', { name: (n) => n.startsWith(WAKE_LABEL) })).toHaveLength(1);
    expect(screen.queryAllByRole('option', { name: (n) => RAW.test(n) })).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  });

  it('a human first prompt shows unchanged in the session row, the conductor row and the strip entry', async () => {
    // Invariant (negative control): a person's prompt keeps the label it always had, whitespace collapsed and nothing renamed.
    seed({
      projects: [proj('labels')],
      instances: [hand('h-human', 'labels', null, { firstPrompt: HUMAN }), conductor('cond-human', { temp: false, firstPrompt: HUMAN })],
      conductSessions: [{ sessionId: 'cond-human', firstPrompt: HUMAN, lastActivity: 1 }],
    });
    const { unmount } = renderSidebar();
    await settle();
    expect(labelOf('h-human').textContent).toBe(HUMAN_LABEL);
    expect(stripLabelOf('h-human')!.textContent).toBe(HUMAN_LABEL);
    expect(named(HUMAN_LABEL).includes(openOf('h-human'))).toBe(true);
    unmount();
    uiStore.set({ lens: 'conductors' });
    renderSidebar();
    await settle();
    expect(named(HUMAN_LABEL).includes(conductorOpenOf('cond-human'))).toBe(true);
  });

  it('a session row whose first prompt is a post-/clear head reads Context renewed, for the caveat record and for the /clear command line', async () => {
    // Invariant: the CLI's head records of a renewed session's file (the caveat, then the /clear line) read by name, never by their tags.
    seed({
      projects: [proj('labels')],
      instances: [hand('h-caveat', 'labels', null, { firstPrompt: CAVEAT }), hand('h-clear', 'labels', null, { firstPrompt: CLEAR })],
    });
    renderSidebar();
    await settle();
    expect(labelOf('h-caveat').textContent).toBe('Context renewed');
    expect(labelOf('h-clear').textContent).toBe('Context renewed');
    expect(named('Context renewed').includes(openOf('h-caveat'))).toBe(true);
    expect(named('Context renewed').includes(openOf('h-clear'))).toBe(true);
    expect(screen.queryAllByRole('button', { name: (n) => n.includes('<local-command-caveat>') || n.includes('<command-name>') })).toHaveLength(0);
  });

  it('a session row whose first prompt is another local command reads its command name with no tags', async () => {
    // Invariant: a command line other than /clear reads as its bare command name.
    seed({ projects: [proj('labels')], instances: [hand('h-compact', 'labels', null, { firstPrompt: COMPACT })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-compact').textContent).toBe('/compact');
    expect(named('/compact').includes(openOf('h-compact'))).toBe(true);
    expect(screen.queryAllByRole('button', { name: (n) => n.includes('<command-') })).toHaveLength(0);
  });

  it('a human prompt that mentions a /clear command line or the local-command caveat mid-text is shown unchanged', async () => {
    // Invariant (negative control): only a prompt that opens with a head record's tag is one.
    const command = 'why is <command-name>/clear</command-name> in my log';
    const caveat = 'what does <local-command-caveat>Caveat: run locally</local-command-caveat> mean';
    seed({
      projects: [proj('labels')],
      instances: [hand('h-cmd-mention', 'labels', null, { firstPrompt: command }), hand('h-caveat-mention', 'labels', null, { firstPrompt: caveat })],
    });
    renderSidebar();
    await settle();
    expect(labelOf('h-cmd-mention').textContent).toBe(command);
    expect(labelOf('h-caveat-mention').textContent).toBe(caveat);
    expect(named(command).includes(openOf('h-cmd-mention'))).toBe(true);
    expect(named(caveat).includes(openOf('h-caveat-mention'))).toBe(true);
  });

  it('a human prompt that mentions the wake marker mid-text is shown unchanged', async () => {
    // Invariant (negative control): only a prompt that opens with the marker is a wake stub.
    const mention = 'why does [[cc:wake-callback]] show here';
    seed({ projects: [proj('labels')], instances: [hand('h-mention', 'labels', null, { firstPrompt: mention })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-mention').textContent).toBe(mention);
    expect(named(mention).includes(openOf('h-mention'))).toBe(true);
  });
});

describe('promptPreview at load', () => {
  afterEach(() => {
    vi.doUnmock('@shared/renewSeed');
    vi.doUnmock('@shared/forwardFrame');
    vi.resetModules();
  });

  it('refuses to load when the renew preamble has no first sentence to recognise it by', async () => {
    // Invariant: a lead that would be empty, so match every prompt, fails loudly at load instead.
    vi.resetModules();
    vi.doMock('@shared/renewSeed', () => ({ RENEW_SEED_PREAMBLE: 'a preamble with no sentence end' }));
    await expect(import('@shared/promptPreview')).rejects.toThrow('RENEW_SEED_PREAMBLE');
  });

  it('refuses to load when the forward header has no first line to recognise it by', async () => {
    // Invariant: as above, for the forward frame's header.
    vi.resetModules();
    vi.doMock('@shared/forwardFrame', async () => ({ ...(await vi.importActual('@shared/forwardFrame')), FORWARD_FRAME_HEADER: 'a header on one line' }));
    await expect(import('@shared/promptPreview')).rejects.toThrow('FORWARD_FRAME_HEADER');
  });
});
