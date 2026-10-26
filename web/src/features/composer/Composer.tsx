import * as React from 'react';
import { ArrowUpIcon, ClockIcon, LoaderCircleIcon, MicIcon, PaperclipIcon, SquareIcon, XIcon, FileIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStore } from '@/state/createStore';
import type { Instance } from '@/state/types';
import { projectLabel } from '@shared/conductors';
import { formatAutoResumeTime } from '@shared/usage';
import { stickyPrompt } from '@/app/controller';
import { on } from '@/app/events';
import { reportPristineDraft, setPristineDraftSource } from '@/app/pristine';
import { voiceStore } from '@/features/voice/store';
import { cn } from '@/lib/utils';
import { NO_ATTACHMENTS, attachmentStore, type Pending } from './attachments';
import { DRAFT_SAVE_DEBOUNCE_MS, EMPTY_DRAFT, draftStore, joinDictation, prependTranscribedTag } from './drafts';
import { openOwner, ownerSendBlock, useWorkerOwner, type WorkerOwner } from '@/features/session/workerOwner';
import { ownerStyle } from '@/features/sidebar/rows';
import { promptSendable, sendPrompt } from './send';
import { ackWorkerSend, isWorkerSendAcked } from './workerSendAck';
import { useDictation, type BoxDelivery } from './useDictation';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_HEIGHT = 240;
const HOLD_TO_DICTATE_MS = 500;
/** Dictates from the message box; spelled as `aria-keyshortcuts` names it. */
const DICTATE_SHORTCUT = 'Alt+Enter';

let nextAttachmentId = 1;

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const isImageType = (mt: string) => /^image\/(png|jpeg|gif|webp)$/i.test(mt);

async function fileToBase64(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000) as any);
  return btoa(s);
}

/** The message box's placeholder for `inst`. */
export function composerPlaceholder(inst: Instance | null, owner: WorkerOwner): string {
  const status = inst?.status ?? null;
  const name = inst ? inst.title || projectLabel(inst.project) : '';
  return !inst ? 'Select or start a session to chat'
    : inst.modelSwitch ? 'Switching model · the session is restarting…'
    : status === 'turn' ? (owner.kind === 'owned' ? `Agent is working · type to steer ${name} (worker of ${owner.label})` : 'Agent is working · type to steer the running turn')
    : status === 'spawning' ? 'Starting the session…'
    : status === 'crashed' || status === 'exited' ? 'The session is not running · resume it to continue'
    : owner.kind === 'owned' ? `Message ${name} · worker of ${owner.label}…`
    : owner.kind === 'unknown' ? `Message ${name} · conducted worker…`
    : `Message ${name}…`;
}

export type ComposerHandle = { focus: () => void };

export const Composer = React.forwardRef<ComposerHandle, { inst: Instance | null; usageSlot?: React.ReactNode }>(function Composer({ inst, usageSlot }, ref) {
  const sid = inst?.sessionId ?? null;
  const [text, setText] = React.useState('');
  const [transcribed, setTranscribed] = React.useState(false);
  const pending = useStore(attachmentStore.store, (s) => s.lists.get(sid) ?? NO_ATTACHMENTS);
  const [dragOver, setDragOver] = React.useState(false);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const sidRef = React.useRef<string | null>(null);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whose hold is pending: a pointer by its id, or the key held on Send. */
  const holdBy = React.useRef<number | 'key' | null>(null);
  const holdDidRecord = React.useRef(false);
  const holdKey = React.useRef<string | null>(null);
  const voice = useStore(voiceStore, (s) => s);
  const dictation = useDictation();
  const owner = useWorkerOwner(inst);
  const ownerBlock = ownerSendBlock(owner);
  const [choice, setChoice] = React.useState(false);
  const blockId = React.useId();

  React.useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }), []);

  const status = inst?.status ?? null;
  const canType = !!inst && ['idle', 'turn', 'spawning'].includes(status!);
  const overageUnarmed = !!inst?.overageStoppedUnarmed;
  const canSend = !!inst && promptSendable(inst);
  const overagePaused = !!(inst?.overageActive || inst?.autoResumeAt) && !overageUnarmed;
  const resumeAt = (inst?.autoResumeAt ?? inst?.overageResetsAt ?? null) as number | null;
  const voiceOn = voice.supported;
  const hasContent = text.trim().length > 0 || pending.some((p) => !p.error);

  const mode: 'recording' | 'transcribing' | 'send' | 'mic' =
    dictation.state !== 'idle' ? dictation.state
      : hasContent ? 'send'
      : canType && voiceOn ? 'mic' : 'send';
  const queueMode = mode === 'send' && overagePaused;
  const dictateKeys = voice.micAvailable && voiceOn;
  const holdOffered = mode === 'send' && dictateKeys;

  // ── Drafts follow the session ───────────────────────────────────────
  const flush = React.useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const cur = sidRef.current;
    if (cur && taRef.current) draftStore.save(cur, { text: taRef.current.value, transcribed: transcribedRef.current });
  }, []);
  const transcribedRef = React.useRef(false);
  transcribedRef.current = transcribed;

  React.useLayoutEffect(() => {
    if (sid === sidRef.current) return;
    flush();
    // A spawning instance's list has no session to stay with, and handing it on could send it to the
    // wrong one. Every other list stays in the store under its session.
    if (sidRef.current === null) attachmentStore.discard(null);
    sidRef.current = sid;
    setChoice(false);
    const d = (sid && draftStore.load(sid)) || EMPTY_DRAFT;
    setText(d.text);
    setTranscribed(!!d.transcribed && !!d.text);
  }, [sid, flush]);

  React.useEffect(() => {
    const onHide = () => flush();
    const onVis = () => { if (document.hidden) flush(); };
    addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => { removeEventListener('pagehide', onHide); document.removeEventListener('visibilitychange', onVis); };
  }, [flush]);

  // A pristine conductor's leave carries what the box holds at that moment (app/pristine.ts).
  React.useEffect(() => setPristineDraftSource(() => ({ sessionId: sidRef.current, text: taRef.current?.value ?? '' })), []);

  // Leaving the session view unmounts the composer: write a pending save now, not from a timer the
  // page may not live to fire. With nothing pending nothing is written, so a restored draft stays as stored.
  React.useLayoutEffect(() => () => { if (saveTimer.current !== undefined) flush(); }, [flush]);

  function noteChange(nextText: string, nextTranscribed: boolean) {
    const cur = sidRef.current;
    if (!cur) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (!nextText) { draftStore.clear(cur); reportPristineDraft(inst, ''); return; }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      draftStore.save(cur, { text: nextText, transcribed: nextTranscribed });
      reportPristineDraft(inst, nextText);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  // Rewind / fork drop their prompt back into the composer.
  React.useEffect(() => on('prefill', ({ text: t }) => {
    clearAttachments();
    setTranscribed(false);
    setText(t);
    noteChange(t, false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }), []);

  // Auto-grow up to a cap.
  React.useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // ── Attachments ─────────────────────────────────────────────────────
  function clearAttachments() {
    attachmentStore.discard(sidRef.current);
  }

  async function addFiles(files: File[]) {
    const entries: [Pending, File][] = [];
    const added: Pending[] = [];
    for (const file of files) {
      if (!file) continue;
      const entry: Pending = { id: nextAttachmentId++, name: file.name || 'file', size: file.size, mediaType: file.type || 'application/octet-stream', isImage: false };
      entry.isImage = isImageType(entry.mediaType);
      if (file.size > MAX_ATTACHMENT_BYTES) entry.error = `too large (max ${fmtSize(MAX_ATTACHMENT_BYTES)})`;
      else {
        if (entry.isImage) { try { entry.objectUrl = URL.createObjectURL(file); } catch { /* no preview */ } }
        entries.push([entry, file]);
      }
      added.push(entry);
    }
    // The files belong to the session showing now, wherever the user is when each encode lands.
    const ownerSid = sidRef.current;
    attachmentStore.add(ownerSid, added);
    for (const [entry, file] of entries) {
      let patch: Pick<Pending, 'dataBase64' | 'error'>;
      try { patch = { dataBase64: await fileToBase64(file) }; } catch (e: any) { patch = { error: `read failed: ${e?.message ?? e}` }; }
      attachmentStore.settle(ownerSid, entry.id, patch);
    }
  }

  function removeAttachment(id: number) {
    attachmentStore.remove(sidRef.current, id);
  }

  // ── Send ────────────────────────────────────────────────────────────
  /** The prompt body the box holds: its text and the attachments that finished encoding; null when there is neither. */
  function buildBody() {
    const t = text.trim();
    const ready = pending.filter((p) => !p.error && typeof p.dataBase64 === 'string');
    if (!t && !ready.length) return null;
    return {
      text: prependTranscribedTag(t, transcribed),
      attachments: ready.map((p) => ({ name: p.name, mediaType: p.mediaType, dataBase64: p.dataBase64 as string })),
    };
  }

  function clearAfterSend() {
    setText('');
    setTranscribed(false);
    clearAttachments();
    noteChange('', false);
  }

  function deliver(target: Instance) {
    const body = buildBody();
    if (!body) return;
    sendPrompt(target, body);
    clearAfterSend();
  }

  function submit() {
    if (!inst || !canSend || !buildBody()) return;
    // A conducted worker's first send from here asks whether the text was meant for its owner.
    if (owner.kind === 'owned' && inst.sessionId && !isWorkerSendAcked(inst.sessionId)) { setChoice(true); return; }
    deliver(inst);
  }

  function sendHere() {
    if (!inst?.sessionId || !canSend || !buildBody()) return;
    ackWorkerSend(inst.sessionId);
    setChoice(false);
    deliver(inst);
  }

  function sendToOwner() {
    if (owner.kind !== 'owned' || !owner.instance || ownerBlock || !canSend || !buildBody()) return;
    deliver(owner.instance);
    setChoice(false);
    openOwner(owner);
  }

  // ── Dictation ───────────────────────────────────────────────────────
  // The box takes a transcript spoken to the session it shows, or one started before the instance
  // had a session id; any other goes to its session's draft. A transcript with no words changes nothing.
  const deliverToBox = React.useRef<BoxDelivery>(() => false);
  deliverToBox.current = (startedIn, t) => {
    if (startedIn && startedIn !== sidRef.current) return false;
    if (!t.trim()) return true;
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    setText((cur) => {
      const before = cur.slice(0, start);
      const insert = joinDictation(before, t).slice(before.length);
      const next = before + insert + cur.slice(end);
      noteChange(next, true);
      requestAnimationFrame(() => {
        const caret = start + insert.length;
        try { taRef.current?.setSelectionRange(caret, caret); taRef.current?.focus(); } catch { /* ignore */ }
      });
      return next;
    });
    setTranscribed(true);
    return true;
  };
  const { offerBox } = dictation;
  React.useEffect(() => offerBox((startedIn, t) => deliverToBox.current(startedIn, t)), [offerBox]);

  function startDictation() {
    void dictation.start(sidRef.current);
  }

  // At most one hold is pending: a gesture that starts one supersedes the pending one, whose release
  // then neither sends nor cancels it.
  function armHold(by: number | 'key') {
    if (by === 'key' && typeof holdBy.current === 'number') holdDidRecord.current = true;
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdBy.current = by;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      holdBy.current = null;
      if (by !== 'key') holdDidRecord.current = true;
      startDictation();
    }, HOLD_TO_DICTATE_MS);
  }
  /** Drops the pending hold when `by` owns it. */
  function cancelHold(by: number | 'key') {
    if (holdBy.current !== by || holdTimer.current === null) return;
    clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdBy.current = null;
  }

  // A pointer hold that started a recording, or that a key hold superseded, swallows the click its
  // release fires, whenever that click comes (on touch it arrives a task later); the next press starts afresh.
  function onSendPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    holdDidRecord.current = false;
    if (mode === 'mic' || mode === 'recording') { e.preventDefault(); return; }
    if (holdOffered) {
      // Focus stays in the box: on a phone a blur closes the keyboard, and the button moves out from
      // under the finger before the hold completes.
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      armHold(e.pointerId);
    }
  }
  function onSendPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    cancelHold(e.pointerId);
  }

  // Space or Enter held on Send is the pointer hold from the keyboard. The browser clicks a button on
  // Enter's keydown, again on each auto-repeat, and on Space's keyup, so a held key's every keydown and
  // its keyup are prevented, and a release while its own hold is pending sends. They stay prevented
  // until that release or a blur, even once the recording runs or a pointer supersedes the hold, so
  // neither the repeats nor the release stop or send anything then; no click follows, so the hold
  // leaves nothing for `holdDidRecord` to swallow. A blur drops the key's hold still pending.
  function onSendKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    // Escape drops whatever hold is pending; a pointer's release then clicks into `holdDidRecord`.
    if (e.key === 'Escape') {
      if (typeof holdBy.current === 'number') holdDidRecord.current = true;
      if (holdBy.current !== null) cancelHold(holdBy.current);
      return;
    }
    const activates = e.key === 'Enter' || e.key === ' ';
    if (holdKey.current !== null) {
      if (activates) e.preventDefault();
      return;
    }
    if (!activates) return;
    // An auto-repeat never presses the button again: on Dictate it would open a second microphone.
    if (e.repeat) { e.preventDefault(); return; }
    holdDidRecord.current = false;
    if (!holdOffered) return;
    e.preventDefault();
    holdKey.current = e.key;
    armHold('key');
  }
  function onSendKeyUp(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== holdKey.current) return;
    e.preventDefault();
    holdKey.current = null;
    if (holdBy.current === 'key') { cancelHold('key'); submit(); }
  }
  function onSendBlur() {
    if (holdKey.current === null) return;
    holdKey.current = null;
    cancelHold('key');
  }
  function onSendClick() {
    if (holdDidRecord.current) { holdDidRecord.current = false; return; }
    if (mode === 'send') submit();
    else if (mode === 'mic') startDictation();
    else if (mode === 'recording') dictation.stop();
  }

  const sendDisabled = mode === 'transcribing' ? true
    : mode === 'mic' ? !voice.micAvailable
    : mode === 'recording' ? false
    : !canSend || !hasContent;
  const sendTitle = mode === 'recording' ? 'Recording · tap to stop and transcribe'
    : mode === 'transcribing' ? 'Transcribing…'
    : mode === 'mic' ? (voice.micAvailable ? `Tap to dictate · tap again to stop · ${DICTATE_SHORTCUT} in the message box` : 'Install Whisper in Settings → Voice to dictate')
    : queueMode ? 'Queue message · delivered when the rate-limit window resets'
    : dictateKeys ? `Send (hold to dictate, or ${DICTATE_SHORTCUT} in the message box)` : 'Send';

  const placeholder = composerPlaceholder(inst, owner);

  const resumeClock = overagePaused ? formatAutoResumeTime(resumeAt)?.replace('resumes at ', '') : null;

  return (
    <div className="space-y-2">
      {choice && owner.kind === 'owned' && (
        <div
          role="group"
          aria-label="Send to worker or conductor"
          data-send-choice
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setChoice(false); taRef.current?.focus(); } }}
        >
          <span className="min-w-0 flex-1 basis-full text-muted-foreground">{inst?.title || (inst && projectLabel(inst.project))} is a worker of {owner.label}.</span>
          <Button size="sm" onClick={sendHere} disabled={!canSend || !hasContent}>Send to worker</Button>
          <Button size="sm" variant="outline" onClick={sendToOwner} disabled={!!ownerBlock || !canSend || !hasContent} aria-describedby={ownerBlock ? blockId : undefined}>
            Send to conductor
          </Button>
          {ownerBlock && <span id={blockId} className="basis-full text-muted-foreground">{ownerBlock}</span>}
        </div>
      )}
      <div
        className={cn(
          'rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-[3px]',
          // One ring colour, chosen here: cn (tailwind-merge) keeps only the last of two ring-colour classes.
          owner.kind === 'owned' ? 'border-(color:--owner-color) focus-within:ring-(color:--owner-color)/40' : 'focus-within:ring-ring/40',
          dragOver && 'ring-[3px] ring-primary/50',
          !canType && 'opacity-80',
        )}
        style={owner.kind === 'owned' ? ownerStyle(owner.sessionId) : undefined}
        data-owner={owner.kind === 'owned' ? owner.sessionId : undefined}
        onDragOver={(e) => {
          if (!canType || !Array.from(e.dataTransfer?.types || []).includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          if (!canType) return;
          const files = Array.from(e.dataTransfer?.files || []);
          if (!files.length) return;
          e.preventDefault();
          void addFiles(files);
        }}
        data-composer
      >
        {(overageUnarmed || overagePaused) && (
          <div className="flex items-center gap-2 rounded-t-2xl border-b bg-warning/10 px-4 py-2 text-xs text-warning">
            <ClockIcon className="size-3.5" />
            {overageUnarmed
              ? "Stopped for account overage. Your conductor resumes this worker; messages can't be queued here."
              : `Paused${resumeClock ? ` until ${resumeClock}` : ''}. New messages are queued.`}
          </div>
        )}
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pending.map((a) => (
              <div key={a.id} className={cn('flex max-w-64 items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-1.5 text-xs', a.error && 'border-destructive/40 text-destructive')}>
                {a.isImage && a.objectUrl ? <img src={a.objectUrl} alt={a.name} className="size-7 rounded object-cover" /> : <FileIcon className="size-4 text-muted-foreground" />}
                <span className="min-w-0 truncate">{a.error ? `${a.name} · ${a.error}` : `${a.name} · ${fmtSize(a.size)}`}</span>
                {!a.error && a.dataBase64 === undefined && <LoaderCircleIcon className="size-3 animate-spin" />}
                <Button variant="ghost" size="icon-sm" className="size-6" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}><XIcon className="size-3" /></Button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          id="composer-input"
          rows={1}
          value={text}
          disabled={!canType}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            const tr = v.trim() ? transcribed : false;
            if (!v.trim()) setTranscribed(false);
            noteChange(v, tr);
          }}
          onKeyDown={(e) => {
            if (choice && e.key === 'Escape') { setChoice(false); return; }
            // ↓ at the very end reveals the sticky prompt; ↑ at the very start hides it.
            if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing) {
              const ta = e.currentTarget;
              if (ta.selectionStart === ta.selectionEnd) {
                if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length) stickyPrompt.reveal();
                else if (e.key === 'ArrowUp' && ta.selectionStart === 0) stickyPrompt.conceal();
              }
            }
            // The shortcut toggles dictation whatever the box holds; an auto-repeat does nothing.
            if (dictateKeys && e.key === 'Enter' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.repeat) return;
              if (dictation.state === 'idle') startDictation();
              else if (dictation.state === 'recording') dictation.stop();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (choice) return;
              if (!sendDisabled && mode === 'send') submit();
            }
          }}
          onPaste={(e) => {
            if (!canType) return;
            const files = Array.from(e.clipboardData?.files || []);
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
          className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          aria-label="Message"
          aria-keyshortcuts={dictateKeys && canType ? DICTATE_SHORTCUT : undefined}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; void addFiles(f); }} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Attach files" className="text-muted-foreground" disabled={!canType} onClick={() => fileRef.current?.click()}>
                <PaperclipIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach files (or paste / drop them)</TooltipContent>
          </Tooltip>
          {dictation.state === 'recording' && (
            <span className="ml-1 flex items-center gap-1.5 text-xs text-destructive">
              <span className="size-2 animate-pulse rounded-full bg-destructive" /> Recording
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => dictation.abort()}>Cancel</Button>
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {usageSlot}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size={queueMode ? 'sm' : 'icon-sm'}
                  variant={mode === 'recording' ? 'destructive' : mode === 'mic' ? 'secondary' : 'default'}
                  className={cn('rounded-full', queueMode && 'px-3')}
                  aria-label={mode === 'mic' ? 'Dictate' : mode === 'recording' ? 'Stop recording' : mode === 'transcribing' ? 'Transcribing' : queueMode ? 'Queue message' : 'Send'}
                  disabled={sendDisabled}
                  onPointerDown={onSendPointerDown}
                  onPointerUp={onSendPointerUp}
                  onPointerCancel={(e) => { cancelHold(e.pointerId); holdDidRecord.current = false; }}
                  onKeyDown={onSendKeyDown}
                  onKeyUp={onSendKeyUp}
                  onBlur={onSendBlur}
                  onClick={onSendClick}
                >
                  {mode === 'recording' ? <SquareIcon className="fill-current" />
                    : mode === 'transcribing' ? <LoaderCircleIcon className="animate-spin" />
                    : mode === 'mic' ? <MicIcon />
                    : queueMode ? <><ClockIcon /> Queue</>
                    : <ArrowUpIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sendTitle}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
});
