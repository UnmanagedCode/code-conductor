import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setSessionFull, setSessionWidth } from '@/app/sessionWidth';
import { ViewShell } from './ViewShell';
import { CostsView } from './CostsView';

beforeEach(() => {
  localStorage.clear();
  act(() => { setSessionWidth(768); setSessionFull(false); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => { setSessionWidth(768); setSessionFull(false); });
});

// Walks the setting 896 -> Full -> 896 and asserts the one width box under the view follows it, with no gutter.
function followsSetting(selector: string) {
  const box = document.querySelector<HTMLElement>(selector);
  expect(box).not.toBeNull();
  expect(document.querySelectorAll(selector)).toHaveLength(1);
  const steps: [() => void, string, string][] = [
    [() => { setSessionWidth(896); }, '896', '896px'],
    [() => { setSessionFull(true); }, 'full', 'none'],
    [() => { setSessionFull(false); }, '896', '896px'],
  ];
  for (const [apply, key, maxWidth] of steps) {
    act(apply);
    expect(box!.dataset.sessionWidth).toBe(key);
    expect(box!.style.maxWidth).toBe(maxWidth);
  }
}

describe('full-page views follow the session width', () => {
  it('ViewShell renders its body at the session width and follows a width change and Full live', () => {
    render(<TooltipProvider><ViewShell title="T" data-view="costs">body</ViewShell></TooltipProvider>);
    followsSetting('main[data-view] [data-session-width]');
  });

  it('the Costs view body carries the session width', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<TooltipProvider><CostsView /></TooltipProvider>);
    followsSetting('main[data-view="costs"] [data-session-width]');
  });
});
