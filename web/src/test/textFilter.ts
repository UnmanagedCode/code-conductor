// Shared drivers for the sidebar text-filter tests: typing into the filter, reading what the tree shows,
// and answering the per-place session lists through `routeFetch`.
import { act, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import type { RoutedCall, Route } from './routeFetch';

export const filterInput = () => document.querySelector('[data-filter-input]') as HTMLInputElement;

/** Types `text` into the filter (replacing its value). */
export async function typeFilter(text: string) {
  await act(async () => { fireEvent.change(filterInput(), { target: { value: text } }); });
}

/** Lets the debounce elapse and every answered load settle (fake timers must be installed). */
export async function settleSearch(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

/** The project rows the list shows, in order. */
export const shownProjects = () =>
  [...document.querySelectorAll('[data-project-list] [data-project-row]')].map((e) => e.getAttribute('data-project-row'));

/** A place's session rows, in order. */
export const rowIds = (key: string) =>
  [...document.querySelectorAll(`ul[data-sessions="${key}"] > li[data-session-row]`)].map((e) => e.getAttribute('data-session-row'));

/** The text of every highlight mark under `root`. */
export const marksIn = (root: Element) => [...root.querySelectorAll('[data-match]')].map((m) => m.textContent);

export const bandOf = (workspace: string) => document.querySelector(`[data-workspace-band="${workspace}"] > button`) as HTMLElement | null;
export const sessionsToggleOf = (project: string) => document.querySelector(`[data-project-sessions="${project}"] > button`) as HTMLElement | null;
export const worktreesToggleOf = (project: string) => document.querySelector(`[data-worktrees="${project}"] > button`) as HTMLElement | null;
export const isOpen = (toggle: HTMLElement | null) => toggle?.getAttribute('aria-expanded') === 'true';

/** The session-list GETs among the recorded calls. */
export const sessionGets = (calls: RoutedCall[]) => calls.filter((c) => c.method === 'GET' && /\/sessions(\?|$)/.test(c.url));

/** A route answering a place's session list with `rows`. */
export const rowsRoute = (rows: unknown[]): Route => () => ({ json: rows });
