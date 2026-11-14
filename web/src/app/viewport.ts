// Keeps the app shell inside the visible viewport while a soft keyboard covers part of it.
// iOS Safari ignores the viewport meta's interactive-widget=resizes-content: the keyboard
// shrinks only the visual viewport, and Safari pans the page to show the focused field.

export const APP_HEIGHT_VAR = '--app-height';
/** Rounding slack: a visual viewport this close to innerHeight is not covered by anything. */
export const HEIGHT_SLACK_PX = 1;
/** A visual-viewport scale this close to 1 counts as not pinch-zoomed. */
export const ZOOM_EPSILON = 0.01;

type Env = {
  win: Pick<Window, 'visualViewport' | 'innerHeight' | 'scrollY' | 'scrollTo'>;
  root: HTMLElement;
};

export function startViewportFollow({ win = window, root = document.documentElement }: Partial<Env> = {}): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};

  const sync = () => {
    const visible = vv.height * vv.scale;
    if (visible < win.innerHeight - HEIGHT_SLACK_PX) root.style.setProperty(APP_HEIGHT_VAR, `${visible}px`);
    else root.style.removeProperty(APP_HEIGHT_VAR);
    // The document never scrolls, so an offset at scale 1 is Safari's keyboard pan. Never fight a pinch-zoom pan.
    if (Math.abs(vv.scale - 1) <= ZOOM_EPSILON && (win.scrollY !== 0 || vv.offsetTop !== 0)) win.scrollTo(0, 0);
  };

  sync();
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
  };
}
