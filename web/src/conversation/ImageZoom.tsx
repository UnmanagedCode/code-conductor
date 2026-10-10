import * as React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * A thumbnail that opens in an in-page overlay. Handling the tap in-page sidesteps
 * Chrome-on-Android's data: URL navigation block and the standalone-PWA custom tab.
 * In the overlay a tap toggles fit-to-screen and 1:1, which pans by scrolling.
 */
export function ImageZoom({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const [actual, setActual] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => { setActual(false); setOpen(true); }} className="block max-w-full cursor-zoom-in" aria-label={`Enlarge ${alt}`}>
        <img src={src} alt={alt} loading="lazy" className={cn('max-w-full object-contain', className)} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(96vw,1400px)] border-0 bg-transparent p-0 shadow-none sm:max-w-[min(96vw,1400px)]">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <div className={cn('max-h-[90dvh] rounded-lg', actual ? 'overflow-auto' : 'overflow-hidden')} data-image-overlay>
            <img
              src={src}
              alt={alt}
              onClick={() => setActual((a) => !a)}
              title={actual ? 'Fit to screen' : 'Actual size'}
              className={cn(actual ? 'max-w-none cursor-zoom-out' : 'max-h-[90dvh] w-full cursor-zoom-in object-contain')}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
