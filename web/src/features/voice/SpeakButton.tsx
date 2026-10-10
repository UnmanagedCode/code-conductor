// Read-aloud toggle for one finalized assistant text block. Renders nothing
// until Piper TTS is available. One button is "active" at a time: the message
// being spoken shows a stop control; tapping another message switches to it.
import { SquareIcon, Volume2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStore } from '@/state/createStore';
import { cn } from '@/lib/utils';
import { voiceStore } from './store';
import { speakStore, toggleSpeak } from './tts';

export function SpeakButton({ text, nodeId }: { text: string; nodeId: string }) {
  const available = useStore(voiceStore, (s) => s.ttsAvailable);
  const speaking = useStore(speakStore, (s) => s.activeNodeId === nodeId);
  if (!available) return null;
  const label = speaking ? 'Stop reading' : 'Read aloud';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={speaking}
          data-speaking={speaking || undefined}
          onClick={(e) => { e.stopPropagation(); toggleSpeak(text, nodeId); }}
          className={cn('size-7 text-muted-foreground', speaking && 'text-primary')}
        >
          {speaking ? <SquareIcon className="size-3 fill-current" /> : <Volume2Icon className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
