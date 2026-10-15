import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Forwarded to the single thumb, which is the element with the slider role. */
  thumbProps?: React.ComponentProps<typeof SliderPrimitive.Thumb>;
};

function Slider({ className, thumbProps, ...props }: SliderProps) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn('relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50', className)}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-1.5 grow overflow-hidden rounded-full bg-input">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        {...thumbProps}
        className={cn(
          'block size-4 rounded-full border border-primary bg-background shadow-sm outline-none transition-[box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none',
          thumbProps?.className,
        )}
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
