import * as React from 'react';
import { MenuIcon, SparklesIcon, FolderPlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OctopusMaestro } from '@/components/mascot/Octopus';
import { useStore } from '@/state/createStore';
import { appStore, activeInstance } from '@/state/app';
import { uiStore } from '@/app/ui';
import { on } from '@/app/events';
import { ConversationView } from '@/conversation/ConversationView';
import { Composer, type ComposerHandle } from '@/features/composer/Composer';
import { openNewProjectDialog } from '@/features/dialogs/api';
import { startConducting } from '@/features/dialogs/conduct';
import { SessionHeader } from './SessionHeader';
import { SubagentPanel, TaskPanel, TurnIndicator } from './SessionPanels';
import { UsageChip } from './UsageChip';
import { focusPromptAfterSelect } from './promptFocus';


function EmptyState() {
  const connection = useStore(appStore, (s) => s.connection);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6 text-center" data-empty-state>
      <OctopusMaestro mood={connection === 'open' ? 'happy' : 'sleepy'} className="size-36 md:size-40" />
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">Ready when you are, maestro</h2>
        <p className="mx-auto max-w-md text-muted-foreground">
          Pick a session from the sidebar, start one in a project, or let a conductor orchestrate several agents for you.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => void startConducting()}><SparklesIcon /> Start conducting</Button>
        <Button variant="outline" onClick={openNewProjectDialog}><FolderPlusIcon /> New project</Button>
      </div>
    </div>
  );
}

export function SessionView() {
  const inst = useStore(appStore, activeInstance);
  const composerRef = React.useRef<ComposerHandle>(null);

  // Focus the prompt after the user picks a session — not on page-load restores,
  // touch devices (the keyboard would cover the transcript), or behind a dialog.
  React.useEffect(() => on('select', ({ userGesture }) => {
    if (userGesture !== true) return;
    // After the newly selected session's composer has rendered.
    requestAnimationFrame(() => focusPromptAfterSelect(userGesture, document.getElementById('composer-input') as HTMLTextAreaElement | null));
  }), []);

  const openSidebar = () => uiStore.set({ sidebarOpen: true });

  if (!inst) {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center px-3 md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={openSidebar}><MenuIcon /></Button>
        </div>
        <EmptyState />
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <SessionHeader inst={inst} onMenu={openSidebar} />
      <ConversationView
        empty={
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <OctopusMaestro mood="curious" className="size-24" />
            <p>No messages yet. Send a prompt to start.</p>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-3xl space-y-2 px-3 pb-[max(env(safe-area-inset-bottom,0px),0.75rem)] md:px-6">
        <TaskPanel inst={inst} />
        <SubagentPanel inst={inst} />
        <TurnIndicator inst={inst} />
        <Composer ref={composerRef} inst={inst} usageSlot={<UsageChip inst={inst} />} />
      </div>
    </main>
  );
}

