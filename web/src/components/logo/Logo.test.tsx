// The logo's renderers on the real arts: only a blinking mark animates, and only
// its cursor; no variant (the lockup included) ships a <style>; the pictures are named. Knockout
// structure is pinned on a synthetic art in logoArt.test.tsx.
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LogoLockup, LogoMark, LogoSmall, LogoTile, Wordmark } from './Logo';
import { MARK } from './logoArt';

/** Every element under `root` (itself included) whose class names an animation. */
const animated = (root: Element) => [root, ...root.querySelectorAll('*')].filter((e) => /\banimate-/.test(e.getAttribute('class') ?? ''));
const VARIANTS = [
  ['a still mark', <LogoMark />], ['the tile', <LogoTile />], ['the small mark', <LogoSmall />], ['the wordmark', <Wordmark />], ['the lockup', <LogoLockup />],
] as const;

describe('Logo', () => {
  it('a blinking mark animates its cursor alone, and stills it under reduced motion', () => {
    // Invariant: blink puts the blink animation and its motion-reduce off-switch on the cursor element, and on nothing else.
    const { container } = render(<LogoMark blink />);
    const svg = container.querySelector('svg[data-logo="mark"]')!;
    const cursor = svg.querySelector('[data-logo-cursor]')!;
    expect(cursor.classList.contains('animate-cursor-blink')).toBe(true);
    expect(cursor.classList.contains('motion-reduce:animate-none')).toBe(true);
    expect(animated(svg)).toEqual([cursor]);
  });

  it.each(VARIANTS)('%s carries no animation class anywhere', (_, el) => {
    // Invariant: a static placement has no animation at all, not one that reduced motion switches off.
    const { container } = render(el);
    expect(container.querySelector('svg[data-logo]'), 'fixture check: the variant renders').not.toBeNull();
    expect(animated(container)).toEqual([]);
  });

  it('no variant carries a <style> element', () => {
    // Invariant: the keyframes live in index.css; an SVG's own <style> would apply page-wide.
    const { container } = render(<>{VARIANTS.map(([name, el]) => <div key={name}>{el}</div>)}<LogoMark blink /></>);
    expect(container.querySelectorAll('svg[data-logo]').length, 'fixture check: every variant renders').toBe(VARIANTS.length + 1);
    expect(container.querySelectorAll('style').length).toBe(0);
  });

  describe('the terminal face', () => {
    afterEach(() => document.documentElement.classList.remove('dark'));

    it.each(['light', 'dark'])('is white in %s mode, in every picture that draws it', (theme) => {
      // Invariant: the face (the screen, the one element with ink "screen") is filled #ffffff whatever the theme; the theme's ink never reaches it.
      if (theme === 'dark') document.documentElement.classList.add('dark');
      const faces = MARK.elements.filter((el) => el.ink === 'screen');
      expect(faces.length, 'fixture check: the mark has one face').toBe(1);
      const d = faces[0].attrs.d;
      const { container } = render(<><LogoMark /><LogoTile /><LogoSmall /><LogoLockup /></>);
      const svgs = container.querySelectorAll('svg[data-logo]');
      expect(svgs.length, 'fixture check: every picture renders').toBe(4);
      for (const svg of svgs) {
        const drawn = svg.querySelectorAll(`path[d="${d}"]`);
        expect(drawn.length, `${svg.getAttribute('data-logo')} draws the face once`).toBe(1);
        expect(drawn[0].getAttribute('fill'), svg.getAttribute('data-logo') ?? '').toBe('#ffffff');
      }
    });
  });

  it('each picture is an image named Code Conductor; the wordmark is decorative', () => {
    // Invariant: the mark, tile, small mark and lockup are role=img named "Code Conductor"; the wordmark is hidden, its container carrying the text.
    const { container } = render(<><LogoMark /><LogoTile /><LogoSmall /><LogoLockup /><Wordmark /></>);
    for (const name of ['mark', 'tile', 'small', 'lockup']) {
      const svg = container.querySelector(`svg[data-logo="${name}"]`)!;
      expect(svg.getAttribute('role'), name).toBe('img');
      expect(svg.getAttribute('aria-label'), name).toBe('Code Conductor');
    }
    const wordmark = container.querySelector('svg[data-logo="wordmark"]')!;
    expect(wordmark.getAttribute('aria-hidden')).toBe('true');
    expect(wordmark.getAttribute('role')).toBeNull();
  });
});
