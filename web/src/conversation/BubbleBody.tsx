/** The cap on a bubble body's height; past it the body scrolls inside the bubble. */
export const BUBBLE_BODY_MAX_HEIGHT = '50dvh';

/**
 * A bubble's aggregated body, scrolled inside the bubble once it outgrows the cap.
 * The bubble's header and controls go outside it. Overscroll is left at the default,
 * so a wheel or swipe at either end chains to the transcript.
 */
export function BubbleBody({ style, ...props }: React.ComponentProps<'div'>) {
  return <div data-bubble-body style={{ ...style, maxHeight: BUBBLE_BODY_MAX_HEIGHT, overflowY: 'auto' }} {...props} />;
}
