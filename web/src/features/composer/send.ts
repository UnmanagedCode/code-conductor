// The one prompt-send path: the composer's Send and the plugin bridge's
// `sendPrompt` both go through here, so a prompt a plugin delivers reaches the
// server exactly as typed text does.
import { send, type ServerMsg } from '@shared/ws';
import { notePristineSent } from '@/app/pristine';
import type { Instance } from '@/state/types';

export type PromptBody = {
  text: string;
  attachments?: { name: string; mediaType: string; dataBase64: string }[];
};

/** Whether the composer's Send is enabled for `inst`. */
export const promptSendable = (inst: Instance): boolean =>
  ['idle', 'turn'].includes(inst.status) && !inst.modelSwitch && !inst.overageStoppedUnarmed;

export function sendPrompt(inst: Instance, body: PromptBody, opts: { ack: true }): Promise<ServerMsg>;
export function sendPrompt(inst: Instance, body: PromptBody): void;
export function sendPrompt(inst: Instance, body: PromptBody, opts?: { ack: true }): Promise<ServerMsg> | void {
  const payload: Record<string, unknown> = { id: inst.id, text: body.text };
  if (body.attachments?.length) payload.attachments = body.attachments;
  notePristineSent(inst.id);
  return opts ? send('prompt', payload, opts) : send('prompt', payload);
}
