// The logo's renderers: only a blinking mark animates, and only its cursor; no
// variant ships a <style>; every knockout mask resolves inside its own SVG, with
// ids that never collide between instances; the pictures are named.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LogoMark, LogoSmall, LogoTile, Wordmark } from './Logo';

/** Every element under `root` (itself included) whose class names an animation. */
const animated = (root: Element) => [root, ...root.querySelectorAll('*')].filter((e) => /\banimate-/.test(e.getAttribute('class') ?? ''));
const VARIANTS = [
  ['a still mark', <LogoMark />], ['the tile', <LogoTile />], ['the small mark', <LogoSmall />], ['the wordmark', <Wordmark />],
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

  it('two marks on one page use disjoint mask ids, and every mask reference resolves inside its own SVG', () => {
    // Invariant: knockouts are masks named per instance, so a second logo never borrows (or breaks) the first one's gaps.
    const { container } = render(<><LogoMark /><LogoMark blink /><LogoTile /><LogoSmall /></>);
    const svgs = [...container.querySelectorAll('svg[data-logo]')];
    const idsOf = (svg: Element) => [...svg.querySelectorAll('mask')].map((m) => m.id);
    for (const svg of svgs) {
      const ids = idsOf(svg);
      expect(ids.length, `fixture check: ${svg.getAttribute('data-logo')} has knockouts`).toBeGreaterThan(0);
      const refs = [...svg.querySelectorAll('[mask]')].map((e) => e.getAttribute('mask')!.match(/^url\(#(.+)\)$/)?.[1]);
      expect(refs.length).toBe(ids.length);
      for (const ref of refs) expect(ids).toContain(ref);
    }
    const all = svgs.flatMap(idsOf);
    expect(new Set(all).size).toBe(all.length);
  });

  it('the tile\'s backdrop rect sits outside every mask, so its gaps show the tile colour', () => {
    // Invariant: a knockout cuts the logo's own layers down to the tile, never through it to the sidebar.
    const { container } = render(<LogoTile />);
    const svg = container.querySelector('svg[data-logo="tile"]')!;
    const plate = [...svg.querySelectorAll('rect')].filter((r) => r.getAttribute('fill') === 'var(--logo-tile)');
    expect(plate.length, 'fixture check: the tile draws its backdrop').toBe(1);
    expect(plate[0].closest('[mask], mask')).toBeNull();
    expect(svg.querySelectorAll('[mask]').length, 'fixture check: the tile has knockouts').toBeGreaterThan(0);
  });

  it('each picture is an image named Code Conductor; the wordmark is decorative', () => {
    // Invariant: the mark, tile and small mark are role=img named "Code Conductor"; the wordmark is hidden, its container carrying the text.
    const { container } = render(<><LogoMark /><LogoTile /><LogoSmall /><Wordmark /></>);
    for (const name of ['mark', 'tile', 'small']) {
      const svg = container.querySelector(`svg[data-logo="${name}"]`)!;
      expect(svg.getAttribute('role'), name).toBe('img');
      expect(svg.getAttribute('aria-label'), name).toBe('Code Conductor');
    }
    const wordmark = container.querySelector('svg[data-logo="wordmark"]')!;
    expect(wordmark.getAttribute('aria-hidden')).toBe('true');
    expect(wordmark.getAttribute('role')).toBeNull();
  });
});
