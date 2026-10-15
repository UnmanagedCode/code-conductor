import { MoveHorizontalIcon, UnfoldHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/state/createStore';
import { sessionWidthStore, setSessionFull } from '@/app/sessionWidth';
import { sessionWidthLabel } from '@/app/sessionWidthScale';
import { Hint } from './rows';

/** The footer's session-width toggle: Full width ↔ Resizable (edge handles on the column). */
export function SessionWidthControl() {
  const width = useStore(sessionWidthStore, (s) => s.width);
  const full = useStore(sessionWidthStore, (s) => s.full);
  const label = `Session width: ${sessionWidthLabel({ width, full })}`;
  return (
    <Hint label={`${label} — click for ${full ? 'resizable' : 'full width'}`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={() => setSessionFull(!full)}
        className="text-muted-foreground hover:text-foreground"
      >
        {full ? <MoveHorizontalIcon /> : <UnfoldHorizontalIcon />}
      </Button>
    </Hint>
  );
}
