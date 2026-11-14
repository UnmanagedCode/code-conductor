import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { SETTLE_QUIET_TURNS, settle } from './settle';

// A chain of `n` zero-delay timers; each runs `step(i)`, the last also runs `last`.
function chain(n: number, step: (i: number) => void, last: () => void = () => {}): void {
  const link = (i: number): void => {
    setTimeout(() => {
      step(i);
      if (i + 1 < n) link(i + 1);
      else last();
    }, 0);
  };
  link(0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('settle', () => {
  it('keeps turning while the DOM keeps changing', async () => {
    const n = SETTLE_QUIET_TURNS + 5;
    chain(n, () => { document.body.appendChild(document.createElement('i')); });
    await settle();
    expect(document.body.querySelectorAll('i')).toHaveLength(n);
  });

  it('turns at least 10 times when the DOM stays quiet', async () => {
    // Pins: the floor of a quiet settle, the longest zero-delay loop among the helpers it stands in for.
    // The link count is a literal on purpose: a count derived from SETTLE_QUIET_TURNS would follow the constant down.
    const landed = vi.fn();
    chain(10, () => {}, landed);
    await settle();
    expect(landed).toHaveBeenCalledOnce();
  });

  it('keeps turning while a text node changes in place', async () => {
    // Pins: characterData changes reset the quiet count, as appended nodes do.
    const text = document.createTextNode('0');
    document.body.appendChild(text);
    const n = SETTLE_QUIET_TURNS + 5;
    chain(n, (i) => { text.nodeValue = String(i + 1); });
    await settle();
    expect(text.nodeValue).toBe(String(n));
  });

  it('fails when the DOM never goes quiet', async () => {
    let stop = false;
    let flip = false;
    const pulse = (): void => {
      if (stop) return;
      flip = !flip;
      document.body.setAttribute('data-flip', String(flip));
      setTimeout(pulse, 0);
    };
    setTimeout(pulse, 0);
    try {
      await expect(settle()).rejects.toThrow(/still changing/);
    } finally {
      stop = true;
    }
  });

  it('under faked setTimeout it runs zero-delay timers without moving the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = vi.fn();
    const later = vi.fn();
    setTimeout(now, 0);
    setTimeout(later, 1);
    await settle();
    expect(now).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  it('with only Date faked it still runs real timers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const done = vi.fn();
    chain(3, () => {}, done);
    await settle();
    expect(done).toHaveBeenCalledOnce();
  });

  it('React updates started during a settle are committed when it resolves', async () => {
    const log = vi.spyOn(console, 'log');
    function Probe() {
      const [stage, setStage] = useState('start');
      useEffect(() => {
        if (stage === 'start') setTimeout(() => setStage('first'), 0);
        if (stage === 'first') setTimeout(() => setStage('second'), 0);
      }, [stage]);
      return <p>{stage}</p>;
    }
    await act(async () => { render(<Probe />); });
    await settle();
    expect(screen.getByText('second')).toBeTruthy();
    expect(log).not.toHaveBeenCalled();
  });
});
