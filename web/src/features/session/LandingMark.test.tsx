// The landing's mark: it assembles on the page load's first landing only, never under reduced
// motion, and after its hand-over is exactly the live mark. happy-dom runs no CSS animation, so
// the end is dispatched by hand (docs/frontend-testing.md); the real end is measured by
// web/e2e/landing-mark.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => undefined }));

import { StrictMode } from 'react';
import { appStore } from '@/state/app';
import { LogoMark } from '@/components/logo/Logo';
import { LandingMark, landingAssembly } from './LandingMark';

const svgOf = (c: HTMLElement) => c.querySelector('svg[data-logo="mark"]')!;
const cursor = (c: HTMLElement) => svgOf(c).querySelector('[data-logo-cursor]')!;
const blinking = (c: HTMLElement) => cursor(c).classList.contains('animate-cursor-blink');
const setConnection = (connection: 'connecting' | 'open' | 'reconnecting') => act(() => appStore.set({ connection }));
/** The svg's markup with the per-instance mask ids (React useId) normalised. */
const norm = (svg: Element) => svg.outerHTML.replace(/[:«»\w-]*k(\d+)/g, 'k$1').replace(/mask-id-\w+/g, '');
const END = (c: HTMLElement, animationName: string) => fireEvent.animationEnd(svgOf(c).querySelector('[data-logo-part="baton"]')!, { animationName });

beforeEach(() => {
  landingAssembly.set({ played: false });
  appStore.set({ connection: 'open' });
});
afterEach(() => { (window as any).happyDOM.settings.device.prefersReducedMotion = 'no-preference'; });

describe('LandingMark', () => {
  it('the first landing assembles with no blink, hands over on the end marker, then is the live mark', () => {
    // Invariant: the first landing of a page load assembles with the cursor still even when connected; only the end marker hands over; afterwards the svg equals a fresh blinking LogoMark's and the blink follows the connection.
    const { container } = render(<LandingMark />);
    expect(svgOf(container).hasAttribute('data-logo-assemble')).toBe(true);
    expect(blinking(container)).toBe(false);
    END(container, 'logo-fade');
    expect(svgOf(container).hasAttribute('data-logo-assemble'), 'a non-final animation end keeps assembling').toBe(true);
    END(container, 'logo-baton-lift');
    expect(svgOf(container).hasAttribute('data-logo-assemble')).toBe(false);
    const fresh = render(<LogoMark blink />);
    expect(norm(svgOf(container))).toBe(norm(svgOf(fresh.container)));
    for (const [connection, on] of [['connecting', false], ['open', true], ['reconnecting', false], ['open', true]] as const) {
      setConnection(connection);
      expect(blinking(container), connection).toBe(on);
    }
  });

  it('a later mount in the same page load is settled, after a finished play and after one cut short', () => {
    // Invariant: "played" counts from the first show: a remount never assembles, whether the first play finished or was unmounted mid-play, and its cursor blinks while open.
    const first = render(<LandingMark />);
    END(first.container, 'logo-baton-lift');
    first.unmount();
    const second = render(<LandingMark />);
    expect(svgOf(second.container).hasAttribute('data-logo-assemble')).toBe(false);
    expect(blinking(second.container)).toBe(true);
    second.unmount();

    landingAssembly.set({ played: false });
    const cut = render(<LandingMark />);
    expect(svgOf(cut.container).hasAttribute('data-logo-assemble'), 'fixture check: mid-play').toBe(true);
    cut.unmount();
    const again = render(<LandingMark />);
    expect(svgOf(again.container).hasAttribute('data-logo-assemble')).toBe(false);
    expect(blinking(again.container)).toBe(true);
  });

  it('StrictMode keeps the first landing assembling', () => {
    // Invariant: the double-invoked initialiser and the simulated remount do not use up the page load's play.
    const { container } = render(<StrictMode><LandingMark /></StrictMode>);
    expect(svgOf(container).hasAttribute('data-logo-assemble')).toBe(true);
  });

  it('under reduced motion the first landing never assembles and is today\'s blinking mark', () => {
    // Invariant: with prefers-reduced-motion: reduce the first landing renders no assembly, the blink class plus motion-reduce:animate-none.
    (window as any).happyDOM.settings.device.prefersReducedMotion = 'reduce';
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches, 'fixture check: the setting reaches matchMedia').toBe(true);
    const { container } = render(<LandingMark />);
    expect(svgOf(container).hasAttribute('data-logo-assemble')).toBe(false);
    expect(cursor(container).classList.contains('animate-cursor-blink')).toBe(true);
    expect(cursor(container).classList.contains('motion-reduce:animate-none')).toBe(true);
  });
});
