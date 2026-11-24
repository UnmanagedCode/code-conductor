import * as React from 'react';
import { LogoMark } from '@/components/logo/Logo';
import { createStore, useStore } from '@/state/createStore';
import { appStore } from '@/state/app';

/** Whether this page load has shown the landing: its mark assembles the first time only. */
export const landingAssembly = createStore({ played: false });

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The landing's mark: assembles on the page load's first landing (never under reduced motion), then is the blinking live mark. */
export function LandingMark({ className }: { className?: string }) {
  const connected = useStore(appStore, (s) => s.connection === 'open');
  const [assembling, setAssembling] = React.useState(
    () => !landingAssembly.get().played && !window.matchMedia(REDUCED_MOTION).matches,
  );
  React.useEffect(() => { landingAssembly.set({ played: true }); }, []);
  return <LogoMark blink={connected} assemble={assembling} onAssembled={() => setAssembling(false)} className={className} />;
}
