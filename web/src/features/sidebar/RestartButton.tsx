import * as React from 'react';
import { RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { Hint } from './rows';
import { performRestart, restartStore } from './restart';

/** Restart the server; with live sessions, ask whether to resume them afterwards. */
export function RestartButton() {
  const inProgress = useStore(restartStore, (s) => s.inProgress);
  const [open, setOpen] = React.useState(false);
  const n = useStore(appStore, (s) => s.instances.length);
  const onClick = () => {
    if (inProgress) return;
    if (appStore.get().instances.length === 0) { void performRestart({ resume: false }); return; }
    setOpen(true);
  };
  const choose = (resume: boolean) => { setOpen(false); void performRestart({ resume }); };
  return (
    <>
      <Hint label="Restart the server (picks up code changes)">
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" disabled={inProgress} onClick={onClick} data-restart>
          <RotateCwIcon className={inProgress ? 'animate-spin' : ''} /> Restart
        </Button>
      </Hint>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-restart-dialog>
          <DialogHeader>
            <DialogTitle>Restart the server?</DialogTitle>
            <DialogDescription>
              {n} active session{n === 1 ? '' : 's'}. Resume them after the restart, or restart only? A plain restart drops them, and temp sessions are archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => choose(false)}>Restart only</Button>
            <Button onClick={() => choose(true)} autoFocus>Restart &amp; resume</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
