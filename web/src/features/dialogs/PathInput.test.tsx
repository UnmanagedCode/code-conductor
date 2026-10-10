import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PathInput, PATH_PICKER_DEBOUNCE_MS, type Placement } from './PathInput';

type Answer = { ok: boolean; entries?: string[]; links?: string[]; truncated?: boolean; max?: number; reason?: string; code?: string } | Error | { status: number };

let answers: Record<string, Answer | Promise<Answer>>;
let requests: string[];
let signals: (AbortSignal | undefined)[];

beforeEach(() => {
  vi.useFakeTimers();
  answers = {};
  requests = [];
  signals = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    signals.push(init?.signal ?? undefined);
    const q = new URLSearchParams(url.split('?')[1]);
    const a = await (answers[q.get('path')!] ?? { ok: true, entries: [] });
    if (a instanceof Error) throw a;
    if ('status' in a) return new Response('nope', { status: a.status });
    return new Response(JSON.stringify(a), { status: 200 });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({ placement = { system: null, remoteId: null }, resetKey }: { placement?: Placement; resetKey?: unknown }) {
  const [v, setV] = React.useState('');
  return <PathInput id="p" value={v} onChange={setV} placement={placement} resetKey={resetKey} />;
}

/** Also offers a button that writes the value from outside the field, as the Adopt dialog's suggestion click does. */
function ExternalHarness({ external }: { external: string }) {
  const [v, setV] = React.useState('');
  return (
    <>
      <PathInput id="p" value={v} onChange={setV} placement={{ system: null, remoteId: null }} />
      <button type="button" onClick={() => setV(external)}>set from outside</button>
    </>
  );
}

const input = () => screen.getByRole('combobox') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const options = () => screen.queryAllByRole('option').map((o) => o.textContent);
async function settle() {
  await act(async () => { vi.advanceTimersByTime(PATH_PICKER_DEBOUNCE_MS); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const note = () => document.querySelector('[data-path-note]')?.textContent ?? '';
/** An answer the test releases later. */
function held() {
  let release!: (a: Answer) => void;
  const answer = new Promise<Answer>((r) => { release = r; });
  return { answer, release };
}
async function land(release: () => void) {
  await act(async () => { release(); });
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
}

describe('PathInput', () => {
  it('debounces: three keystrokes in one directory make one request, after the delay', async () => {
    answers['/srv'] = { ok: true, entries: ['app', 'api', 'data'] };
    render(<Harness />);
    type('/srv/a');
    type('/srv/ap');
    type('/srv/app');
    expect(requests).toHaveLength(0);
    await settle();
    expect(requests).toHaveLength(1);
    expect(options()).toEqual(['app']);
  });

  it('re-filters within a loaded directory with no new request', async () => {
    answers['/srv'] = { ok: true, entries: ['app', 'api', 'data'] };
    render(<Harness />);
    type('/srv/');
    await settle();
    expect(options()).toEqual(['api', 'app', 'data']);
    type('/srv/d');
    expect(options()).toEqual(['data']);
    expect(requests).toHaveLength(1);
  });

  it('sends only the path for a local placement, and system plus remote when chosen', async () => {
    const { unmount } = render(<Harness />);
    type('/x/');
    await settle();
    expect(requests[0]).toBe('/api/fs/dirs?path=%2Fx');
    unmount();
    render(<Harness placement={{ system: 'box', remoteId: 'c1' }} />);
    type('/x/');
    await settle();
    expect(requests[1]).toBe('/api/fs/dirs?path=%2Fx&system=box&remoteId=c1');
  });

  it('a relative value makes no request', async () => {
    render(<Harness />);
    type('srv/a');
    await settle();
    expect(requests).toHaveLength(0);
  });

  it('shows dot-directories only when the prefix starts with a dot', async () => {
    answers['/h'] = { ok: true, entries: ['.cache', 'code'] };
    render(<Harness />);
    type('/h/');
    await settle();
    expect(options()).toEqual(['code']);
    type('/h/.');
    expect(options()).toEqual(['.cache']);
  });

  it('merges links into one sorted list and marks them', async () => {
    answers['/h'] = { ok: true, entries: ['b'], links: ['a'] };
    render(<Harness />);
    type('/h/');
    await settle();
    expect(options()).toEqual(['a', 'b']);
    expect(screen.getAllByRole('option')[0].getAttribute('title')).toMatch(/Symlink/);
  });

  it('a truncated listing names the max in the note', async () => {
    answers['/h'] = { ok: true, entries: ['a'], truncated: true, max: 500 };
    render(<Harness />);
    type('/h/');
    await settle();
    expect(screen.getByText(/more than 500 directories/)).toBeTruthy();
  });

  it('Tab completes the first option when none is active, and lists the new directory next', async () => {
    answers['/h'] = { ok: true, entries: ['code', 'cave'] };
    answers['/h/cave'] = { ok: true, entries: ['x'] };
    render(<Harness />);
    type('/h/c');
    await settle();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(input().value).toBe('/h/cave/');
    await settle();
    expect(options()).toEqual(['x']);
  });

  it('arrows wrap and Enter completes the active option', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b', 'c'] };
    render(<Harness />);
    type('/h/');
    await settle();
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('/h/a/');
  });

  it('Escape closes an open list', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    render(<Harness />);
    type('/h/');
    await settle();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(options()).toEqual([]);
  });

  it('shows a refusal reason and caches it; a transient refusal is not cached', async () => {
    answers['/no'] = { ok: false, reason: 'permission denied' };
    answers['/slow'] = { ok: false, reason: 'timed out', code: 'LIST_TIMEOUT' };
    render(<Harness />);
    type('/no/');
    await settle();
    expect(screen.getByText('permission denied')).toBeTruthy();
    type('/no/x');
    await settle();
    expect(requests.filter((r) => r.includes('%2Fno'))).toHaveLength(1);
    type('/slow/');
    await settle();
    type('/slow/x');
    await settle();
    expect(requests.filter((r) => r.includes('%2Fslow'))).toHaveLength(2);
  });

  it('an HTTP error puts up a note and is not cached', async () => {
    answers['/e'] = { status: 500 };
    render(<Harness />);
    type('/e/');
    await settle();
    expect(screen.getByText(/Could not list \/e \(HTTP 500\)/)).toBeTruthy();
    type('/e/a');
    await settle();
    expect(requests).toHaveLength(2);
  });

  it('a new resetKey clears the cache', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    const { rerender } = render(<Harness resetKey={1} />);
    type('/h/');
    await settle();
    rerender(<Harness resetKey={2} />);
    type('/h/a');
    await settle();
    expect(requests).toHaveLength(2);
  });

  it('names render as text, never markup', async () => {
    answers['/h'] = { ok: true, entries: ['<b>x</b>'] };
    render(<Harness />);
    type('/h/');
    await settle();
    expect(screen.getByRole('option').innerHTML).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  // The cache key carries the system: an unchanged resetKey still lists the same directory again on another system.
  it('the cache key includes the placement: the same directory on another system is its own request', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    const { rerender } = render(<Harness placement={{ system: null, remoteId: null }} resetKey={1} />);
    type('/h/');
    await settle();
    rerender(<Harness placement={{ system: 'box', remoteId: null }} resetKey={1} />);
    type('/h/a');
    await settle();
    expect(requests).toHaveLength(2);
    expect(new URLSearchParams(requests[1].split('?')[1]).get('system')).toBe('box');
  });

  // The cache key carries the target: each target's listing is fetched once and kept, with no reset in between.
  it('the cache key includes the target: each target of a system lists the same directory once, with no reset between', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b'] };
    const { rerender } = render(<Harness placement={{ system: 'box', remoteId: 'r1' }} resetKey={1} />);
    type('/h/');
    await settle();
    rerender(<Harness placement={{ system: 'box', remoteId: 'r2' }} resetKey={1} />);
    type('/h/a');
    await settle();
    expect(requests.map((r) => new URLSearchParams(r.split('?')[1]).get('remoteId'))).toEqual(['r1', 'r2']);
    rerender(<Harness placement={{ system: 'box', remoteId: 'r1' }} resetKey={1} />);
    type('/h/');
    await settle();
    expect(requests).toHaveLength(2);
    expect(options()).toEqual(['a', 'b']);
  });

  // A reset aborts the pending request, and its answer, when it lands, shows neither a list nor a note.
  it('a new resetKey aborts the request in flight, and its late answer renders nothing', async () => {
    const h = held();
    answers['/h'] = h.answer;
    const { rerender } = render(<Harness resetKey={1} />);
    type('/h/');
    await settle();
    expect(signals[0]?.aborted).toBe(false);
    rerender(<Harness resetKey={2} />);
    expect(signals[0]?.aborted).toBe(true);
    await land(() => h.release({ ok: true, entries: ['a'], truncated: true, max: 1 }));
    expect(options()).toEqual([]);
    expect(note()).toBe('');
  });

  // A reset closes the open list and empties the cache, so a directory listed before it is fetched again.
  it('a new resetKey closes the open list and clears the cache: the same directory is fetched again', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    const { rerender } = render(<Harness resetKey={1} />);
    type('/h/');
    await settle();
    expect(options()).toEqual(['a']);
    rerender(<Harness resetKey={2} />);
    expect(options()).toEqual([]);
    type('/h/a');
    await settle();
    expect(requests).toHaveLength(2);
    expect(options()).toEqual(['a']);
  });

  // The field opts out of the browser's own autocomplete and spellcheck and declares its list.
  it('the input opts out of browser autocomplete and spellcheck and declares a list', () => {
    render(<Harness />);
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().getAttribute('spellcheck')).toBe('false');
    expect(input().getAttribute('aria-autocomplete')).toBe('list');
  });

  // While a listing is pending the note says so, naming the directory; a landed listing clears it.
  it('the note says Listing <dir>… while the request is pending, and clears when it lands', async () => {
    const h = held();
    answers['/srv'] = h.answer;
    render(<Harness />);
    type('/srv/');
    await settle();
    expect(note()).toBe('Listing /srv…');
    await land(() => h.release({ ok: true, entries: ['a'] }));
    expect(note()).toBe('');
    expect(options()).toEqual(['a']);
  });

  // The field is a combobox controlling its list, expanded only while open, and tracks the active option by id.
  it('the input and every option carry the combobox wiring', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b'] };
    render(<Harness />);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    type('/h/');
    await settle();
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-controls')).toBe('p-completions');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox').id).toBe('p-completions');
    expect(screen.getAllByRole('option').map((o) => o.id)).toEqual(['p-completions-opt-0', 'p-completions-opt-1']);
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe('p-completions-opt-0');
  });

  // Typing into another directory aborts the pending listing, and its late answer never replaces the new one.
  it('moving to another directory aborts the pending request, and its late answer renders nothing', async () => {
    const h = held();
    answers['/a'] = h.answer;
    answers['/b'] = { ok: true, entries: ['from-b'] };
    render(<Harness />);
    type('/a/f');
    await settle();
    type('/b/f');
    expect(signals[0]?.aborted).toBe(true);
    await settle();
    expect(options()).toEqual(['from-b']);
    await land(() => h.release({ ok: true, entries: ['from-a'] }));
    expect(options()).toEqual(['from-b']);
  });

  // A listing that lands after the value moved elsewhere without the field's own input is cached for its directory but not shown.
  it('an answer for a directory the value has since left is cached, not rendered', async () => {
    const h = held();
    answers['/a'] = h.answer;
    render(<ExternalHarness external="/zzz/" />);
    type('/a/q');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'set from outside' }));
    await land(() => h.release({ ok: true, entries: ['from-a'] }));
    expect(options()).toEqual([]);
    type('/a/f');
    await settle();
    expect(requests).toHaveLength(1);
    expect(options()).toEqual(['from-a']);
  });

  // Tab completes the option the arrows made active.
  it('Tab completes the active option, not the first', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b', 'c'] };
    render(<Harness />);
    type('/h/');
    await settle();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(input().value).toBe('/h/b/');
  });

  // With no active option, ArrowUp enters the list at its last option and ArrowDown at its first.
  it('ArrowUp from no active option selects the last; ArrowDown from none selects the first', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b', 'c'] };
    const first = render(<Harness />);
    type('/h/');
    await settle();
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    first.unmount();
    render(<Harness />);
    type('/h/');
    await settle();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  });

  // Shift+Tab with a list open is the browser's: not prevented, and the value is left as typed.
  it('Shift+Tab is left to the browser: not prevented, value unchanged', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    render(<Harness />);
    type('/h/');
    await settle();
    expect(options()).toEqual(['a']);
    expect(fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })).toBe(true);
    expect(input().value).toBe('/h/');
  });

  // Enter with a list open but no active option is not prevented and completes nothing, so the form still submits.
  it('Enter with no active option is left alone so the form still submits', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    render(<Harness />);
    type('/h/');
    await settle();
    expect(options()).toEqual(['a']);
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(true);
    expect(input().value).toBe('/h/');
  });

  // An Escape that closes the list is prevented and goes no further; with the list closed Escape passes through untouched.
  it('Escape that closes an open list is stopped; with the list closed it is not prevented', async () => {
    answers['/h'] = { ok: true, entries: ['a'] };
    const seen = vi.fn();
    document.body.addEventListener('keydown', seen);
    try {
      render(<Harness />);
      type('/h/');
      await settle();
      expect(options()).toEqual(['a']);
      expect(fireEvent.keyDown(input(), { key: 'Escape' })).toBe(false);
      expect(seen).not.toHaveBeenCalled();
      expect(options()).toEqual([]);
      expect(fireEvent.keyDown(input(), { key: 'Escape' })).toBe(true);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener('keydown', seen);
    }
  });

  // A press on the list keeps focus in the field (mousedown prevented), and a click completes that option.
  it('clicking an option completes it, and a mousedown on the list keeps focus in the input', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b'] };
    render(<Harness />);
    type('/h/');
    await settle();
    const b = screen.getAllByRole('option')[1];
    expect(fireEvent.mouseDown(b)).toBe(false);
    fireEvent.click(b);
    expect(input().value).toBe('/h/b/');
  });

  // Leaving the field closes the list but keeps the listing cached for the next keystroke.
  it('blur closes the list but keeps the cache', async () => {
    answers['/h'] = { ok: true, entries: ['a', 'b'] };
    render(<Harness />);
    type('/h/');
    await settle();
    fireEvent.blur(input());
    expect(options()).toEqual([]);
    type('/h/a');
    await settle();
    expect(requests).toHaveLength(1);
    expect(options()).toEqual(['a']);
  });

  // Each transient refusal code shows its reason and is never cached, so the next keystroke in that directory asks again.
  it('every transient refusal code is shown and retried, never cached', async () => {
    for (const code of ['LIST_TIMEOUT', 'ETIMEDOUT', 'ETRANSPORT', 'SYSTEM_UNREACHABLE']) {
      requests.length = 0;
      answers['/t'] = { ok: false, reason: `refused: ${code}`, code };
      const r = render(<Harness />);
      type('/t/');
      await settle();
      expect(note(), code).toBe(`refused: ${code}`);
      answers['/t'] = { ok: true, entries: ['e1'] };
      type('/t/e');
      await settle();
      expect(requests, code).toHaveLength(2);
      expect(options(), code).toEqual(['e1']);
      r.unmount();
    }
  });

  // A refusal with no reason still explains itself in words, never by its bare code.
  it('a refusal without a reason still says something, never the bare code', async () => {
    answers['/nope'] = { ok: false, code: 'ENOENT' };
    render(<Harness />);
    type('/nope/');
    await settle();
    expect(note()).toBe('Could not list /nope.');
    expect(note()).not.toContain('ENOENT');
  });

  // A network failure names its message in the note and is not cached.
  it('a network error puts up a note and is not cached', async () => {
    answers['/n'] = new Error('offline');
    render(<Harness />);
    type('/n/');
    await settle();
    expect(note()).toMatch(/offline/);
    type('/n/a');
    await settle();
    expect(requests).toHaveLength(2);
  });
});
