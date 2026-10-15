import * as React from 'react';
import { FoldHorizontalIcon, MoveHorizontalIcon, UnfoldHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useStore } from '@/state/createStore';
import { resetSessionWidth, sessionWidthStore, setSessionFull, setSessionWidth } from '@/app/sessionWidth';
import {
  SESSION_WIDTH_MAX, SESSION_WIDTH_MIN, SESSION_WIDTH_SNAPS, SESSION_WIDTH_STEP, sessionWidthLabel, snapSessionWidth,
} from '@/app/sessionWidthScale';
import { Hint } from './rows';

function triggerIcon(width: number, full: boolean) {
  if (full) return <MoveHorizontalIcon />;
  return width > SESSION_WIDTH_SNAPS[0].px ? <UnfoldHorizontalIcon /> : <FoldHorizontalIcon />;
}

const pct = (px: number) => `${((px - SESSION_WIDTH_MIN) / (SESSION_WIDTH_MAX - SESSION_WIDTH_MIN)) * 100}%`;

/** The footer's session-width popover: a px slider with Normal/Wide snap ticks, and a Full width switch. */
export function SessionWidthControl() {
  const width = useStore(sessionWidthStore, (s) => s.width);
  const full = useStore(sessionWidthStore, (s) => s.full);
  const label = `Session width: ${sessionWidthLabel({ width, full })}`;
  const switchId = React.useId();
  // Snapping applies to pointer drags only: a keyboard step off a snap point must not snap back.
  const dragging = React.useRef(false);
  return (
    <Popover>
      <Hint label={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground hover:text-foreground">
            {triggerIcon(width, full)}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent side="top" align="start" aria-label="Session width" data-session-width-popover className="space-y-3">
        <div className="flex items-center justify-between text-sm font-medium">
          <span>Session width</span>
          <span className="text-muted-foreground">{full ? 'Full' : `${width} px`}</span>
        </div>
        <div>
          <Slider
            min={SESSION_WIDTH_MIN}
            max={SESSION_WIDTH_MAX}
            step={SESSION_WIDTH_STEP}
            value={[width]}
            disabled={full}
            thumbProps={{ 'aria-label': 'Session width', 'aria-valuetext': `${width} px` }}
            onValueChange={([v]) => setSessionWidth(dragging.current ? snapSessionWidth(v) : v)}
            onPointerDown={() => { dragging.current = true; }}
            onKeyDown={() => { dragging.current = false; }}
            onDoubleClick={resetSessionWidth}
          />
          <div className="relative mt-1 h-5">
            {SESSION_WIDTH_SNAPS.map((snap) => (
              <span key={`tick-${snap.label}`} aria-hidden style={{ left: pct(snap.px) }} className="absolute -top-1.5 h-1.5 w-px bg-muted-foreground/60" />
            ))}
            {SESSION_WIDTH_SNAPS.map((snap) => (
              <button
                key={snap.label}
                type="button"
                disabled={full}
                onClick={() => setSessionWidth(snap.px)}
                style={{ left: pct(snap.px) }}
                className="absolute -translate-x-1/2 rounded px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50"
              >
                {snap.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor={switchId}>Full width</Label>
          <Switch id={switchId} checked={full} onCheckedChange={setSessionFull} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
