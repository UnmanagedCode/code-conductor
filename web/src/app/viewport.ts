// Keeps the app shell on the visible area while a soft keyboard covers part of the page.
// iOS Safari ignores the viewport meta's interactive-widget=resizes-content: the keyboard shrinks only the
// visual viewport, and Safari pans it (offsetTop) to show the focused field, leaving the document where it is.
// The layout viewport (documentElement.clientHeight) never shrinks for the keyboard; innerHeight does in the
// standalone (home-screen) webview, so coverage is measured against the layout viewport. While covered the shell
// takes the visible height and is translated by the pan, so its on-screen box is exactly the visible area.

export const APP_HEIGHT_VAR = '--app-height';
export const APP_TOP_VAR = '--app-top';
export const APP_LEFT_VAR = '--app-left';
/** Rounding slack: a visual viewport this close to the layout viewport's height is not covered by anything. */
export const HEIGHT_SLACK_PX = 1;
/** A visual-viewport scale this close to 1 counts as not pinch-zoomed. */
export const ZOOM_EPSILON = 0.01;

type Env = {
  win: Pick<Window, 'visualViewport' | 'scrollY' | 'scrollTo'>;
  root: HTMLElement;
};

export function startViewportFollow({ win = window, root = document.documentElement }: Partial<Env> = {}): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};

  const sync = () => {
    const visible = vv.height * vv.scale;
    const unzoomed = Math.abs(vv.scale - 1) <= ZOOM_EPSILON;
    if (visible < root.clientHeight - HEIGHT_SLACK_PX) {
      root.style.setProperty(APP_HEIGHT_VAR, `${visible}px`);
      // At scale 1 the offset is the keyboard pan, which the shell follows. A pinch-zoom pan is the user's: no translate.
      if (unzoomed) {
        root.style.setProperty(APP_TOP_VAR, `${vv.offsetTop}px`);
        root.style.setProperty(APP_LEFT_VAR, `${vv.offsetLeft}px`);
      } else {
        root.style.removeProperty(APP_TOP_VAR);
        root.style.removeProperty(APP_LEFT_VAR);
      }
      // Nothing scrolls while covered: a reset here cancels Safari's pan, once per keystroke.
      return;
    }
    root.style.removeProperty(APP_HEIGHT_VAR);
    root.style.removeProperty(APP_TOP_VAR);
    root.style.removeProperty(APP_LEFT_VAR);
    // The document never scrolls by design; undo a leftover document scroll, never a visual-viewport offset.
    if (unzoomed && win.scrollY !== 0) win.scrollTo(0, 0);
  };

  sync();
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
  };
}
