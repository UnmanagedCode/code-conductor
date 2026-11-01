import * as React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { tapFraction, zoomScroll } from './zoomScroll';

/**
 * A thumbnail that opens in an in-page overlay. Handling the tap in-page sidesteps
 * Chrome-on-Android's data: URL navigation block and the standalone-PWA custom tab.
 * In the overlay a tap toggles fit-to-screen and 1:1; the 1:1 view is centred when it fits and otherwise starts with the tapped spot under the pointer, then pans by scrolling.
 */
export function ImageZoom({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const [actual, setActual] = React.useState(false);
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
        <DialogContent className="max-w-[min(96vw,1400px)] border-0 bg-transparent p-0 shadow-none sm:max-w-[min(96vw,1400px)]">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <div ref={wrapperRef} className={cn('max-h-[90dvh] rounded-lg', actual ? 'max-w-full justify-self-center overflow-auto' : 'overflow-hidden')} data-image-overlay>
            <img
              src={src}
              alt={alt}
              onClick={toggle}
              title={actual ? 'Fit to screen' : 'Actual size'}
              className={cn(actual ? 'max-w-none cursor-zoom-out' : 'max-h-[90dvh] w-full cursor-zoom-in object-contain')}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
