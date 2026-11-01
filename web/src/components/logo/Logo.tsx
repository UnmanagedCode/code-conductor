// The logo's React renderers. The drawing and the knockout masks come from
// logoArt.ts; the cursor's blink keyframes live in index.css, so no logo SVG
// carries a <style>, and only a blinking mark carries an animation class.
import * as React from 'react';
import {
  APP_INKS, knockoutTree, MARK, SMALL16, TILE, viewBoxRect, WORDMARK, type Art, type KnockoutNode, type LogoElement,
} from './logoArt';

const BLINK = 'animate-cursor-blink motion-reduce:animate-none';

const reactAttrs = (attrs: Record<string, string>) => Object.fromEntries(
  Object.entries(attrs).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
);

function Shape({ el, fill, blink }: { el: LogoElement; fill: string; blink?: boolean }) {
  const Tag = el.tag;
  const cursor = el.cursor ? { 'data-logo-cursor': '', className: blink ? BLINK : undefined } : {};
  return <Tag {...reactAttrs(el.attrs)} fill={fill} {...cursor} />;
}

function LogoSvg({ art, name, blink = false, className }: {
  art: Art; name: 'mark' | 'tile' | 'small' | 'wordmark'; blink?: boolean; className?: string;
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
    ? <Shape key={i} el={n.el} fill={ink(n.el)} blink={blink} />
    : <g key={i} mask={`url(#${id}k${n.mask})`}>{n.children.map(node)}</g>);
  const a11y = name === 'wordmark' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'Code Conductor' };
  return (
    <svg viewBox={art.viewBox} className={className} data-logo={name} {...a11y}>
      {masks.length > 0 && (
        <defs>
          {masks.map((m, i) => (
            <mask key={i} id={`${id}k${i}`} maskUnits="userSpaceOnUse" {...box}>
              <rect {...box} fill="#fff" />
              <Shape el={m} fill="#000" />
            </mask>
          ))}
        </defs>
      )}
      {art.base?.map((el, i) => <Shape key={i} el={el} fill={ink(el)} />)}
      {tree.map(node)}
    </svg>
  );
}

/** The full mark. `blink` animates the cursor; motion-reduce stills it. */
export function LogoMark({ blink = false, className }: { blink?: boolean; className?: string }) {
  return <LogoSvg art={MARK} name="mark" blink={blink} className={className} />;
}

/** The sidebar header's tile. */
export function LogoTile({ className }: { className?: string }) {
  return <LogoSvg art={TILE} name="tile" className={className} />;
}

/** The 16px design, for menu rows. */
export function LogoSmall({ className }: { className?: string }) {
  return <LogoSvg art={SMALL16} name="small" className={className} />;
}

/** "Code Conductor" outlined; decorative, so its container carries the text. */
export function Wordmark({ className }: { className?: string }) {
  return <LogoSvg art={WORDMARK} name="wordmark" className={className} />;
}
