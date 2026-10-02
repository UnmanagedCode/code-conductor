// Input gestures that summon and dismiss the sticky prompt header
// (public/stickyPrompt.js owns the state; this module only reads input).
//
// Keyboard: Down in the composer with the caret at the very end reveals, Up
// with the caret at the very start conceals — no modifier, no selection, no IME
// composition. At those caret positions the browser's own Down/Up does
// nothing, so the key is never prevented and typing is unchanged.
//
// Touch: a vertical swipe that starts on one of `swipeZones` (the session top
// bar and the pin itself). Touch events keep targeting the element the touch
// started on, so a finger drifting into the transcript is still tracked, and
// nothing listens on the transcript, so its own scrolling is never taken over.
// The zones carry `touch-action: pan-x pinch-zoom` in styles.css so the
// browser starts no vertical pan there (no pull-to-refresh, no scroll
// chaining) and pinch zoom still works. Not gated on the
// mobile layout breakpoint: touch events come only from touch input, and the
// breakpoint would shut out touch tablets.

// Vertical travel that commits a swipe.
export const SWIPE_MIN_PX = 40;

export function installPromptReveal({ textarea, swipeZones, onReveal, onConceal }) {
  textarea.addEventListener('keydown', (e) => {
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const { selectionStart, selectionEnd, value } = textarea;
    if (selectionStart !== selectionEnd) return;
    if (e.key === 'ArrowDown' && selectionEnd === value.length) onReveal();
    else if (e.key === 'ArrowUp' && selectionStart === 0) onConceal();
  });
  for (const zone of swipeZones) trackSwipes(zone, onReveal, onConceal);
}

function trackSwipes(zone, onDown, onUp) {
  let start = null; // the tracked touch's start point; null while not tracking
  const passive = { passive: true };
  zone.addEventListener('touchstart', (e) => {
    // The overflow dropdown sits inside the top bar and scrolls on its own.
    start = e.touches.length === 1 && !e.target.closest?.('[role="menu"]')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : null;
  }, passive);
  zone.addEventListener('touchmove', (e) => {
    if (!start) return;
    if (e.touches.length > 1) { start = null; return; }
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax >= SWIPE_MIN_PX && ax > ay) { start = null; return; }
    if (ay >= SWIPE_MIN_PX && ay >= 2 * ax) {
      start = null; // once per gesture
      if (dy > 0) onDown(); else onUp();
    }
  }, passive);
  const stop = () => { start = null; };
  zone.addEventListener('touchend', stop, passive);
  zone.addEventListener('touchcancel', stop, passive);
}
