// The headless argv contract: `node server.ts --prompt <text> | --prompt-file
// <path|-> [--mode code|plan] [--output-format text|json|stream-json]
// [--include-workers]`. Pure — the entry (src/headless/entry.ts) reads the
// prompt and boots. An argv carrying none of the headless flags is an ordinary
// boot, whatever else it holds; once one is present, every argument must be one
// of them.

import { promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import { OUTPUT_FORMATS, type OutputFormat } from './result.ts';

export type HeadlessMode = 'code' | 'plan';
export type HeadlessSource = { prompt: string } | { file: string };

export type HeadlessArgs =
  | { kind: 'none' }
  | { kind: 'headless'; source: HeadlessSource; mode: HeadlessMode; format: OutputFormat; includeWorkers: boolean }
  // `format`: the requested --output-format when it is valid, else `json` — the
  // shape the usage result is printed in.
  | { kind: 'usage'; message: string; format: OutputFormat };

export const HEADLESS_SYNOPSIS = 'usage: node server.ts (--prompt <text> | --prompt-file <path|->) [--mode code|plan] [--output-format text|json|stream-json] [--include-workers]';

const VALUE_FLAGS = ['--prompt', '--prompt-file', '--mode', '--output-format'] as const;
const INCLUDE_WORKERS = '--include-workers';
const FLAGS = [...VALUE_FLAGS, INCLUDE_WORKERS] as const;
type ValueFlag = typeof VALUE_FLAGS[number];
type Flag = typeof FLAGS[number];
const MODES: readonly HeadlessMode[] = ['code', 'plan'];

// The flag an argument names (bare or `=`-joined), or null.
function flagOf(arg: string): Flag | null {
  for (const f of FLAGS) if (arg === f || arg.startsWith(`${f}=`)) return f;
  return null;
}

const isFormat = (v: string | undefined): v is OutputFormat => (OUTPUT_FORMATS as readonly string[]).includes(v as string);

export function parseHeadlessArgs(argv: string[]): HeadlessArgs {
  if (!argv.some((a) => flagOf(a) !== null)) return { kind: 'none' };
  const values = new Map<ValueFlag, string>();
  let includeWorkers = false;
  // The first error wins, but the loop reads on where it can so a usage result
  // still knows the requested format.
  let error: string | null = null;
  const record = (message: string) => { error ??= message; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = flagOf(arg);
    if (flag === null) { record(`unexpected argument '${arg}' in a headless run`); continue; }
    if (flag === INCLUDE_WORKERS) {
      if (arg.length > flag.length) record(`${flag} takes no value`);
      else if (includeWorkers) record(`${flag} given more than once`);
      includeWorkers = true;
      continue;
    }
    const repeated = values.has(flag);
    if (repeated) record(`${flag} given more than once`);
    let value: string | undefined;
    if (arg.length > flag.length) value = arg.slice(flag.length + 1);
    else if (i + 1 < argv.length) value = argv[++i];
    if (value === undefined || value === '') { record(`${flag} needs a value`); break; }
    if (!repeated) values.set(flag, value);
  }
  const requested = values.get('--output-format');
  const format: OutputFormat = isFormat(requested) ? requested : 'json';
  const usage = (message: string): HeadlessArgs => ({ kind: 'usage', message, format });
  if (error !== null) return usage(error);
  const prompt = values.get('--prompt');
  const file = values.get('--prompt-file');
  if (prompt !== undefined && file !== undefined) return usage('give --prompt or --prompt-file, not both');
  if (prompt === undefined && file === undefined) {
    // Only a lone --mode reached here before the output flags existed; its text stays.
    const newTrigger = requested !== undefined || includeWorkers;
    return usage(newTrigger ? 'a headless run needs --prompt or --prompt-file' : '--mode needs --prompt or --prompt-file');
  }
  const mode = values.get('--mode') ?? 'code';
  if (!(MODES as readonly string[]).includes(mode)) return usage(`--mode must be one of ${MODES.join(' | ')}, got '${mode}'`);
  if (requested !== undefined && !isFormat(requested)) return usage(`--output-format must be one of ${OUTPUT_FORMATS.join(' | ')}, got '${requested}'`);
  if (includeWorkers && format !== 'stream-json') return usage('--include-workers needs --output-format stream-json');
  return {
    kind: 'headless',
    source: prompt !== undefined ? { prompt } : { file: file as string },
    mode: mode as HeadlessMode,
    format,
    includeWorkers,
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
    try { for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); }
    catch (e) { return { kind: 'usage', message: `cannot read the prompt from stdin: ${(e as Error).message}` }; }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    try { text = await readFile(source.file); }
    catch (e) { return { kind: 'usage', message: `cannot read --prompt-file ${source.file}: ${(e as Error).message}` }; }
  }
  if (text.trim() === '') return { kind: 'usage', message: 'the prompt is empty' };
  return { kind: 'prompt', text };
}
