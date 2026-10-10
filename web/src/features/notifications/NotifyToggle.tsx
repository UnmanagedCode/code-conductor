// The sidebar header's notifications control: on / off, with the blocked and
// unsupported states explained in its tooltip.
import { BellIcon, BellOffIcon, BellRingIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStore } from '@/state/createStore';
import { cn } from '@/lib/utils';
import { notificationStore, toggleNotifications } from './notifications';

export function notifyToggleState(permission: string, globalEnabled: boolean) {
  const on = globalEnabled && permission === 'granted';
  const title = permission === 'unsupported' ? 'This browser does not support notifications'
    : permission === 'denied' ? 'Notifications are blocked. Allow them in the browser site settings.'
    : on ? 'Notifications on: you hear about sessions that wait on you or finish. Click to turn off.'
    : 'Notifications off. Click to turn on.';
  return { on, title, blocked: permission === 'denied' || permission === 'unsupported' };
}

export function NotifyToggle({ className }: { className?: string }) {
  const { permission, globalEnabled } = useStore(notificationStore, (s) => s);
  const { on, title, blocked } = notifyToggleState(permission, globalEnabled);
  const Icon = on ? BellRingIcon : blocked ? BellOffIcon : BellIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={on ? 'Turn notifications off' : 'Turn notifications on'}
          aria-pressed={on}
          data-notify={on ? 'on' : blocked ? 'blocked' : 'off'}
          onClick={() => void toggleNotifications()}
          className={cn('text-muted-foreground hover:text-foreground', on && 'text-primary hover:text-primary', blocked && 'opacity-60', className)}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{title}</TooltipContent>
    </Tooltip>
  );
}
