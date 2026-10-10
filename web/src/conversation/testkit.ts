/// <reference types="node" />
// Shared helpers for the conversation tests: event fixtures, feeding the
// server's own parser / transcript replay into a model, and readable views
// of the model (item shapes, group headers, compaction labels).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationModel, type AssistantNode, type GroupNode, type RootItem } from './model';
import { summarizeGroup } from './tools';
import { compactionLabel } from './format';
import type { UiEvent } from '@/state/types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../../tests/fixtures');

export const readJsonl = (name: string): any[] =>
  readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The server's own parser and transcript replay, loaded through a computed path
// so the web typecheck doesn't pull the server tree in under its own flags.
const SERVER_SRC = path.resolve(here, '../../../src');
export type ServerParser = { handleObject: (frame: any) => UiEvent[] };
export async function serverModules(): Promise<{
  Parser: new () => ServerParser;
  replayPersistedLine: (line: any) => UiEvent[];
  loadPersistedTranscript: (o: any) => Promise<{ events: UiEvent[] } & Record<string, any>>;
  loadSubAgentTranscript: (o: any) => Promise<UiEvent[] | any>;
  encodeCwd: (cwd: string) => string;
  localPlace: (cwd: string) => any;
}> {
  const parser = await import(/* @vite-ignore */ path.join(SERVER_SRC, 'parser.ts'));
  const transcript = await import(/* @vite-ignore */ path.join(SERVER_SRC, 'transcript.ts'));
  const projects = await import(/* @vite-ignore */ path.join(SERVER_SRC, 'projects.ts'));
  return { Parser: parser.Parser, ...transcript, encodeCwd: projects.encodeCwd, localPlace: projects.localPlace };
}

let seq = 0;
/** Apply with a fresh _seq, as the server stamps live events. */
export const apply = (m: ConversationModel, ev: UiEvent) => m.apply({ ...ev, _seq: ++seq });
export const feed = (m: ConversationModel, evs: UiEvent[]) => { for (const ev of evs) m.apply(ev); };

// The server injects a model_changed ahead of every CLI init (the model the
// session switched to); live fixtures replay that the same way.
export const MODEL_CHANGED = { kind: 'system', subtype: 'model_changed', data: { from: 'claude-haiku-4-5-20251001', to: 'claude-haiku-4-5' } };

export function feedFrames(m: ConversationModel, parser: ServerParser, frames: any[]) {
  for (const frame of frames) {
    for (const ev of parser.handleObject(frame)) {
      if (ev.kind === 'system' && ev.subtype === 'init') apply(m, MODEL_CHANGED);
      apply(m, ev);
    }
  }
}

export function replayLines(m: ConversationModel, replay: (line: any) => UiEvent[], lines: any[]) {
  for (const line of lines) for (const ev of replay(line)) apply(m, ev);
}

export const thinking = (msgId: string, blockIdx: number, text = 'pondering'): UiEvent[] => [
  { kind: 'thinking_start', msgId, blockIdx },
  { kind: 'thinking_delta', msgId, blockIdx, text },
  { kind: 'thinking_end', msgId, blockIdx },
];
export const text = (msgId: string, blockIdx: number, body: string): UiEvent[] => [
  { kind: 'text_delta', msgId, blockIdx, text: body },
  { kind: 'text_end', msgId, blockIdx },
];
export function tool(msgId: string, blockIdx: number, id: string, name: string,
  { result = 'ok' as string | null, isError = false, yielded = false, input = { command: 'x' } as object } = {}): UiEvent[] {
  const evs: UiEvent[] = [
    { kind: 'tool_use_start', msgId, blockIdx, toolUseId: id, name },
    { kind: 'tool_use', msgId, blockIdx, toolUseId: id, name, input },
  ];
  if (result !== null) evs.push({ kind: 'tool_result', toolUseId: id, content: result, isError, ...(yielded ? { yielded: true } : {}) });
  return evs;
}

/** The root item types, e.g. ['user', 'assistant', 'compaction']. */
export const shape = (m: ConversationModel) => m.items.map((i) => i.type);

/** The header text a group shows, in the old renderer's wording: "3 actions · Bash ×2, Read · 1 error". */
export function groupText(g: GroupNode) {
  const s = summarizeGroup(g);
  const names = s.parts.map(({ label, k }) => (k > 1 ? `${label} ×${k}` : label));
  if (s.more) names.push(`+${s.more} more`);
  let out = `${s.n} action${s.n === 1 ? '' : 's'}`;
  if (names.length) out += ` · ${names.join(', ')}`;
  if (s.errors) out += ` · ${s.errors} error${s.errors === 1 ? '' : 's'}`;
  return out;
}

export const groupsOf = (w: AssistantNode) => w.children.filter((c): c is GroupNode => c.type === 'group');
export const assistants = (m: ConversationModel) => m.items.filter((i): i is AssistantNode => i.type === 'assistant');
export const users = (m: ConversationModel) => m.items.filter((i) => i.type === 'user') as Extract<RootItem, { type: 'user' }>[];

export const compactionLabels = (m: ConversationModel) =>
  m.items.filter((i) => i.type === 'compaction').map((c) => compactionLabel(c as any));

/** Subtypes of the system lines the conversation shows. */
export const systemSubtypes = (m: ConversationModel) =>
  m.items.filter((i) => i.type === 'system').map((i) => (i as any).ev.subtype);
