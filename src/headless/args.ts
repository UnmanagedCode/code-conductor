// The headless argv contract: `node server.ts --prompt <text> | --prompt-file
// <path|-> [--mode code|plan]`. Pure — the entry (src/headless/entry.ts) reads
// the prompt and boots. An argv carrying none of the three flags is an ordinary
// boot, whatever else it holds; once one is present, every argument must be one
// of them.

import { promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';

export type HeadlessMode = 'code' | 'plan';
export type HeadlessSource = { prompt: string } | { file: string };

export type HeadlessArgs =
  | { kind: 'none' }
  | { kind: 'headless'; source: HeadlessSource; mode: HeadlessMode }
  | { kind: 'usage'; message: string };

export const HEADLESS_SYNOPSIS = 'usage: node server.ts (--prompt <text> | --prompt-file <path|->) [--mode code|plan]';

const FLAGS = ['--prompt', '--prompt-file', '--mode'] as const;
type Flag = typeof FLAGS[number];
const MODES: readonly HeadlessMode[] = ['code', 'plan'];

// The flag an argument names (bare or `=`-joined), or null.
function flagOf(arg: string): Flag | null {
  for (const f of FLAGS) if (arg === f || arg.startsWith(`${f}=`)) return f;
  return null;
}

const usage = (message: string): HeadlessArgs => ({ kind: 'usage', message });

export function parseHeadlessArgs(argv: string[]): HeadlessArgs {
  if (!argv.some((a) => flagOf(a) !== null)) return { kind: 'none' };
  const values = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = flagOf(arg);
    if (flag === null) return usage(`unexpected argument '${arg}' in a headless run`);
    if (values.has(flag)) return usage(`${flag} given more than once`);
    let value: string | undefined;
    if (arg.length > flag.length) value = arg.slice(flag.length + 1);
    else if (i + 1 < argv.length) value = argv[++i];
    if (value === undefined || value === '') return usage(`${flag} needs a value`);
    values.set(flag, value);
  }
  const prompt = values.get('--prompt');
  const file = values.get('--prompt-file');
  if (prompt !== undefined && file !== undefined) return usage('give --prompt or --prompt-file, not both');
  if (prompt === undefined && file === undefined) return usage('--mode needs --prompt or --prompt-file');
  const mode = values.get('--mode') ?? 'code';
  if (!(MODES as readonly string[]).includes(mode)) return usage(`--mode must be one of ${MODES.join(' | ')}, got '${mode}'`);
  return {
    kind: 'headless',
    source: prompt !== undefined ? { prompt } : { file: file as string },
    mode: mode as HeadlessMode,
  };
}

export interface PromptReadDeps {
  readFile?: (p: string) => Promise<string>;
  stdin?: Readable;
}

// The prompt text, or a usage error: an unreadable file, or a prompt that is
// empty once trimmed. `-` reads all of stdin.
export async function readHeadlessPrompt(
  source: HeadlessSource,
  { readFile = (p) => fs.readFile(p, 'utf8'), stdin = process.stdin }: PromptReadDeps = {},
): Promise<{ kind: 'prompt'; text: string } | { kind: 'usage'; message: string }> {
  let text: string;
  if ('prompt' in source) {
    text = source.prompt;
  } else if (source.file === '-') {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    try { text = await readFile(source.file); }
    catch (e) { return { kind: 'usage', message: `cannot read --prompt-file ${source.file}: ${(e as Error).message}` }; }
  }
  if (text.trim() === '') return { kind: 'usage', message: 'the prompt is empty' };
  return { kind: 'prompt', text };
}
