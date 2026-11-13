import { PowerIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useStore } from '@/state/createStore';
import { Hint } from './rows';
import { performRestart, performShutdown, powerStore } from './restart';

/** The sidebar footer's power menu: Restart or Shut down cc. Both carry the live sessions over. */
export function PowerMenu() {
  const inProgress = useStore(powerStore, (s) => s.inProgress);
  return (
    <DropdownMenu modal={false}>
      <Hint label="Restart or shut down cc">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={inProgress} aria-label="Power" data-power-menu>
            <PowerIcon className={inProgress ? 'animate-pulse' : ''} />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" side="top" className="w-44">
        <DropdownMenuItem onSelect={() => { void performRestart(); }}>
          <RotateCwIcon /> Restart
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void performShutdown(); }}>
          <PowerIcon /> Shut down
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
