// The one prompt-send path: the composer's Send and the plugin bridge's
// `sendPrompt` both go through here, so a prompt a plugin delivers reaches the
// server exactly as typed text does.
import { send } from '@shared/ws';
import type { AckFrame } from '@shared/wsFrames';
import { notePristineSent } from '@/app/pristine';
import type { Instance } from '@/state/types';

export type PromptBody = {
  text: string;
  attachments?: { name: string; mediaType: string; dataBase64: string }[];
  /** The revision of the context chip this send consumes; only the composer's own Send names one. */
  chip?: number;
};

/** Whether the composer's Send is enabled for `inst`. */
export const promptSendable = (inst: Instance): boolean =>
  ['idle', 'turn'].includes(inst.status) && !inst.modelSwitch && !inst.overageStoppedUnarmed;

export function sendPrompt(inst: Instance, body: PromptBody, opts: { ack: true }): Promise<AckFrame>;
export function sendPrompt(inst: Instance, body: PromptBody): void;
export function sendPrompt(inst: Instance, body: PromptBody, opts?: { ack: true }): Promise<AckFrame> | void {
  const payload: Record<string, unknown> = { id: inst.id, text: body.text };
  if (body.attachments?.length) payload.attachments = body.attachments;
  if (body.chip !== undefined) payload.chip = body.chip;
  notePristineSent(inst.id);
  return opts ? send('prompt', payload, opts) : send('prompt', payload);
}
