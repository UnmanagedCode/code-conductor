// The logo's React renderers. The drawing and the knockout masks come from
// logoArt.ts; the keyframes (the cursor's blink, the landing assembly) live in
// index.css, so no logo SVG carries a <style>. Only a blinking mark carries an
// animation class, and the assembly is attribute-driven: an assembling mark tags
// each shape with its `part`, and a settled mark carries no assembly attribute.
import * as React from 'react';
import {
  APP_INKS, FAV16, knockoutTree, LOCKUP, MARK, TILE, viewBoxRect, WORDMARK, type Art, type KnockoutNode, type LogoElement,
} from './logoArt';

/** index.css's last assembly animation to end; its `animationend` hands the mark over. */
const ASSEMBLY_END = 'logo-baton-lift';

const BLINK = 'animate-cursor-blink motion-reduce:animate-none';

const reactAttrs = (attrs: Record<string, string>) => Object.fromEntries(
  Object.entries(attrs).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
);

function Shape({ el, fill, blink, assemble }: { el: LogoElement; fill: string; blink?: boolean; assemble?: boolean }) {
  const Tag = el.tag;
  const cursor = el.cursor ? { 'data-logo-cursor': '', className: blink ? BLINK : undefined } : {};
  const paint = el.stroke ? { fill: 'none', stroke: fill } : { fill };
  const part = assemble ? { 'data-logo-part': el.part } : {};
  return <Tag {...reactAttrs(el.attrs)} {...paint} {...cursor} {...part} />;
}

function LogoSvg({ art, name, blink = false, assemble = false, onAssembled, className }: {
  art: Art; name: 'mark' | 'tile' | 'small' | 'wordmark' | 'lockup'; blink?: boolean; assemble?: boolean; onAssembled?: () => void; className?: string;
}) {
  const id = React.useId();
  const { masks, tree } = knockoutTree(art.elements);
  const box = viewBoxRect(art.viewBox);
  const ink = (el: LogoElement) => {
    const fill = APP_INKS[el.ink!];
    if (!fill) throw new Error(`logo: the app has no colour for ink "${el.ink}"`);
    return fill;
  };
  const node = (n: KnockoutNode, i: number): React.ReactNode => ('el' in n
    ? <Shape key={i} el={n.el} fill={ink(n.el)} blink={blink && !assemble} assemble={assemble} />
    : <g key={i} mask={`url(#${id}k${n.mask})`}>{n.children.map(node)}</g>);
  const root = assemble
    ? { 'data-logo-assemble': '', onAnimationEnd: (e: React.AnimationEvent) => { if (e.animationName === ASSEMBLY_END) onAssembled?.(); } }
    : {};
  const a11y = name === 'wordmark' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'Code Conductor' };
  return (
    <svg viewBox={art.viewBox} className={className} data-logo={name} {...a11y} {...root}>
      {masks.length > 0 && (
        <defs>
          {masks.map((m, i) => (
            <mask key={i} id={`${id}k${i}`} maskUnits="userSpaceOnUse" {...box}>
              <rect {...box} fill="#fff" />
              <Shape el={m} fill="#000" assemble={assemble} />
            </mask>
          ))}
        </defs>
      )}
      {art.base?.map((el, i) => <Shape key={i} el={el} fill={ink(el)} />)}
      {tree.map(node)}
    </svg>
  );
}

/** The full mark. `blink` animates the cursor; motion-reduce stills it. `assemble` plays the landing's assembly instead (no blink meanwhile) and calls `onAssembled` when it ends. */
export function LogoMark({ blink = false, assemble = false, onAssembled, className }: {
  blink?: boolean; assemble?: boolean; onAssembled?: () => void; className?: string;
}) {
  return <LogoSvg art={MARK} name="mark" blink={blink} assemble={assemble} onAssembled={onAssembled} className={className} />;
}

/** The mark and wordmark together, never animated: Settings → About. */
export function LogoLockup({ className }: { className?: string }) {
  return <LogoSvg art={LOCKUP} name="lockup" className={className} />;
}

/** The sidebar header's tile. */
export function LogoTile({ className }: { className?: string }) {
  return <LogoSvg art={TILE} name="tile" className={className} />;
}

/** The 16px favicon's art, for menu rows: its face is white. */
export function LogoSmall({ className }: { className?: string }) {
  return <LogoSvg art={FAV16} name="small" className={className} />;
}

/** "Code Conductor" outlined; decorative, so its container carries the text. */
export function Wordmark({ className }: { className?: string }) {
  return <LogoSvg art={WORDMARK} name="wordmark" className={className} />;
}
