import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PathInput, PATH_PICKER_DEBOUNCE_MS, type Placement } from './PathInput';

type Answer = { ok: boolean; entries?: string[]; links?: string[]; truncated?: boolean; max?: number; reason?: string; code?: string } | Error | { status: number };

let answers: Record<string, Answer>;
let requests: string[];

beforeEach(() => {
  vi.useFakeTimers();
  answers = {};
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    const q = new URLSearchParams(url.split('?')[1]);
    const a = answers[q.get('path')!] ?? { ok: true, entries: [] };
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

const input = () => screen.getByRole('combobox') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const options = () => screen.queryAllByRole('option').map((o) => o.textContent);
async function settle() {
  await act(async () => { vi.advanceTimersByTime(PATH_PICKER_DEBOUNCE_MS); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
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
});
