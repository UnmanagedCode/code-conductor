import * as React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { tapFraction, zoomScroll } from './zoomScroll';

const FIT_MAX_W = 'min(96vw, 1400px)';
const FIT_MAX_H = '90dvh';

/**
 * A thumbnail that opens in an in-page overlay. Handling the tap in-page sidesteps
 * Chrome-on-Android's data: URL navigation block and the standalone-PWA custom tab.
 * In the overlay a tap on the image toggles fit-to-screen and 1:1; the 1:1 view is centred when it fits and otherwise starts with the tapped spot under the pointer, then pans by scrolling.
 * A tap anywhere outside the image closes it. The fit image is sized from its aspect ratio, so its box is the painted image and has no letterbox band to catch a tap.
 */
export function ImageZoom({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const [actual, setActual] = React.useState(false);
  const [ratio, setRatio] = React.useState<number | null>(null);
  const pressOnSurface = React.useRef(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const pendingTap = React.useRef<{ fx: number; fy: number; clientX: number; clientY: number } | null>(null);

  React.useLayoutEffect(() => {
    const tap = pendingTap.current;
    const wrapper = wrapperRef.current;
    const img = wrapper?.querySelector('img');
    pendingTap.current = null;
    if (!actual || !tap || !wrapper || !img || !img.naturalWidth) return;
    const r = wrapper.getBoundingClientRect();
    const pointer = {
      x: Math.min(Math.max(tap.clientX - r.left, 0), wrapper.clientWidth),
      y: Math.min(Math.max(tap.clientY - r.top, 0), wrapper.clientHeight),
    };
    const { left, top } = zoomScroll(tap, img, pointer, wrapper);
    wrapper.scrollLeft = left;
    wrapper.scrollTop = top;
  }, [actual]);

  const toggle = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!actual) {
      const img = e.currentTarget;
      const box = img.getBoundingClientRect();
      pendingTap.current = {
        ...tapFraction({ x: e.clientX - box.left, y: e.clientY - box.top }, box, img),
        clientX: e.clientX, clientY: e.clientY,
      };
    }
    setActual((a) => !a);
  };
  return (
    <>
      <button type="button" onClick={() => { setActual(false); setOpen(true); }} className="block max-w-full cursor-zoom-in" aria-label={`Enlarge ${alt}`}>
        <img src={src} alt={alt} loading="lazy" className={cn('max-w-full object-contain', className)} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="border-0 bg-transparent p-0 shadow-none"
          style={{ maxWidth: FIT_MAX_W }}
          onPointerDown={(e) => { pressOnSurface.current = e.target === e.currentTarget; }}
          onClick={(e) => { if (e.target === e.currentTarget && pressOnSurface.current) setOpen(false); }}
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <div ref={wrapperRef} style={{ maxHeight: FIT_MAX_H }} className={cn('max-w-full justify-self-center rounded-lg', actual ? 'overflow-auto' : 'overflow-hidden')} data-image-overlay>
            <img
              src={src}
              alt={alt}
              onClick={toggle}
              onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w > 0 && h > 0) setRatio(w / h); }}
              title={actual ? 'Fit to screen' : 'Actual size'}
              style={actual ? undefined : { maxHeight: FIT_MAX_H, width: ratio ? `min(${FIT_MAX_W}, calc(${FIT_MAX_H} * ${ratio}))` : undefined }}
              className={cn(actual ? 'max-w-none cursor-zoom-out' : 'h-auto max-w-full cursor-zoom-in')}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
