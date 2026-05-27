// Tap-to-zoom overlay for conversation images. Sidesteps the data:-URL
// navigation block in Chrome on Android (and the standalone-PWA CCT
// hijack) by handling the click in-page — no new tab, no URL change.
//
// Triggers on any <img> inside .conversation: tool_result images
// (.tool-result-img), markdown-rendered images (.md img), and user
// attachment thumbnails (.block-image-img). Esc or backdrop tap closes.

let backdrop = null;
let bigImg = null;
let escHandler = null;
let zoomed = false;

// Toggle between fit-to-screen (default) and 1:1 native resolution. In
// zoomed mode the backdrop scrolls so a larger-than-viewport image can be
// panned; flex-centering would clip the top/left out of reach.
function setZoom(on) {
  zoomed = on;
  if (backdrop) backdrop.classList.toggle('zoomed', on);
  if (bigImg) bigImg.classList.toggle('zoomed', on);
}

function ensureOverlay() {
  if (backdrop) return;
  backdrop = document.createElement('div');
  backdrop.className = 'lightbox-backdrop';
  backdrop.hidden = true;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  bigImg = document.createElement('img');
  bigImg.className = 'lightbox-img';
  bigImg.setAttribute('alt', '');
  // Tap the image to toggle full native resolution; stopPropagation so the
  // tap doesn't bubble to the backdrop's close handler.
  bigImg.addEventListener('click', (e) => { e.stopPropagation(); setZoom(!zoomed); });
  backdrop.appendChild(bigImg);
  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
}

function open(src) {
  ensureOverlay();
  bigImg.setAttribute('src', src);
  setZoom(false); // every image starts fit-to-screen
  backdrop.hidden = false;
  document.body.classList.add('lightbox-open');
  if (!escHandler) {
    escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
  }
}

function close() {
  if (!backdrop || backdrop.hidden) return;
  backdrop.hidden = true;
  setZoom(false);
  bigImg.removeAttribute('src');
  document.body.classList.remove('lightbox-open');
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

function isTargetImg(img) {
  if (!img || img.tagName !== 'IMG') return false;
  if (img.classList.contains('lightbox-img')) return false;
  // Anchor inside .conversation, or one of the known image classes.
  if (img.classList.contains('tool-result-img')) return true;
  if (img.classList.contains('block-image-img')) return true;
  if (img.closest('.md')) return true;
  return false;
}

export function installLightbox({ doc = document } = {}) {
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!isTargetImg(img)) return;
    e.preventDefault();
    e.stopPropagation();
    const src = img.getAttribute('src');
    if (src) open(src);
  }, true); // capture phase — beats the anchor-wrap default and the
            // external-link opener's bubble-phase handler.
}

export const _internal = { open, close };
