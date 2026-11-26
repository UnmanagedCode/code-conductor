// The entry argv contract, for every boot `node server.ts` makes:
//   node server.ts (--prompt <text> | --prompt-file <path|->) [--mode code|plan]
//     [--output-format text|json|stream-json] [--include-workers] [--ui <mode>]
//   node server.ts --replay [--session <id>] [--ui <mode>]   (src/headless/replay.ts)
//   node server.ts [--ui full|view]                           (an ordinary server)
// Pure — the entry (src/headless/entry.ts) reads the prompt and boots.
// One value-aware pass: `--ui` consumes its value, so a value is never read as
// a flag. An argv with no headless flag (as a flag, not a value) is an
// ordinary boot whose unknown arguments are ignored; once a headless flag is
// present, every argument must be a headless flag or `--ui`. `--ui` alone
// never makes a boot headless. Mode names: shared/uiMode.ts.

import { promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import { OUTPUT_FORMATS, type OutputFormat } from './result.ts';
import { UI_MODES, isUiMode, type UiMode } from '../../shared/uiMode.ts';

export type HeadlessMode = 'code' | 'plan';
export type HeadlessSource = { prompt: string } | { file: string };

export type EntryArgs =
  | { kind: 'server'; ui: 'full' | 'view' }
  // An ordinary server's refused `--ui`: printed with ENTRY_SYNOPSIS, exit 2, before boot.
  | { kind: 'server_usage'; message: string }
  | { kind: 'headless'; source: HeadlessSource; mode: HeadlessMode; format: OutputFormat; includeWorkers: boolean; ui: UiMode }
  // `--replay`: serve a finished run's session; `session` is `--session`, or null for the last run's.
  | { kind: 'replay'; session: string | null; ui: UiMode }
  // `format`: the requested --output-format when it is valid, else `json` — the
  // shape the usage result is printed in.
  | { kind: 'usage'; message: string; format: OutputFormat };

export const ENTRY_SYNOPSIS = [
  'usage: node server.ts (--prompt <text> | --prompt-file <path|->) [--mode code|plan] [--output-format text|json|stream-json] [--include-workers] [--ui full|view|interact]',
  '       node server.ts --replay [--session <id>] [--ui full|view|interact]',
  '       node server.ts [--ui full|view]',
].join('\n');

// What a headless-family boot runs in without `--ui`; an ordinary server's is `full`.
const HEADLESS_DEFAULT_UI: UiMode = 'view';

const UI = '--ui';
const VALUE_FLAGS = ['--prompt', '--prompt-file', '--mode', '--output-format', '--session'] as const;
const INCLUDE_WORKERS = '--include-workers';
const REPLAY = '--replay';
// Bare flags: no value.
const SWITCHES = [INCLUDE_WORKERS, REPLAY] as const;
const FLAGS = [...VALUE_FLAGS, ...SWITCHES] as const;
// What a replay refuses beside it: every flag of a run.
const RUN_FLAGS = ['--prompt', '--prompt-file', '--mode', '--output-format', INCLUDE_WORKERS] as const;
type ValueFlag = typeof VALUE_FLAGS[number];
type Flag = typeof FLAGS[number];
const MODES: readonly HeadlessMode[] = ['code', 'plan'];

// The flag an argument names (bare or `=`-joined), or null.
function flagOf(arg: string): Flag | typeof UI | null {
  for (const f of [...FLAGS, UI] as const) if (arg === f || arg.startsWith(`${f}=`)) return f;
  return null;
}

const isFormat = (v: string | undefined): v is OutputFormat => (OUTPUT_FORMATS as readonly string[]).includes(v as string);

export function parseEntryArgs(argv: string[]): EntryArgs {
  const values = new Map<ValueFlag, string>();
  let includeWorkers = false;
  let replay = false;
  const seen: Flag[] = [];
  // The first error of each family wins; the loop reads on where it can so a
  // usage result still knows the requested format.
  let error: string | null = null;
  // The `--ui` errors alone: an ordinary server reports only these.
  let uiError: string | null = null;
  let ui: string | undefined;
  const record = (message: string) => { error ??= message; };
  const recordUi = (message: string) => { uiError ??= message; record(message); };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = flagOf(arg);
    // Refused only in a headless run, which `error` alone reports.
    if (flag === null) { record(`unexpected argument '${arg}' in a headless run`); continue; }
    if (flag === UI) {
      let value: string | undefined;
      if (arg.length > UI.length) value = arg.slice(UI.length + 1);
      else if (i + 1 < argv.length) value = argv[++i];
      if (ui !== undefined) recordUi(`${UI} given more than once`);
      else if (value === undefined || value === '') recordUi(`${UI} needs a value`);
      else if (!isUiMode(value)) recordUi(`${UI} must be one of ${UI_MODES.join(' | ')}, got '${value}'`);
      if (ui === undefined) ui = value ?? '';
      continue;
    }
    seen.push(flag);
    if (flag === INCLUDE_WORKERS || flag === REPLAY) {
      const already = flag === REPLAY ? replay : includeWorkers;
      if (arg.length > flag.length) record(`${flag} takes no value`);
      else if (already) record(`${flag} given more than once`);
      if (flag === REPLAY) replay = true; else includeWorkers = true;
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

  if (seen.length === 0) {
    // An ordinary server: unknown arguments are ignored, `--ui` is checked.
    if (uiError !== null) return { kind: 'server_usage', message: uiError };
    if (ui === 'interact') return { kind: 'server_usage', message: `${UI} interact needs a headless run (--prompt / --prompt-file) or ${REPLAY}` };
    return { kind: 'server', ui: (ui ?? 'full') as 'full' | 'view' };
  }

  const requested = values.get('--output-format');
  const format: OutputFormat = isFormat(requested) ? requested : 'json';
  const usage = (message: string): EntryArgs => ({ kind: 'usage', message, format });
  if (error !== null) return usage(error);
  const mode = (ui ?? HEADLESS_DEFAULT_UI) as UiMode;
  if (replay) {
    const clash = seen.find((f) => (RUN_FLAGS as readonly string[]).includes(f));
    if (clash !== undefined) return usage(`${REPLAY} cannot be combined with ${clash}`);
    return { kind: 'replay', session: values.get('--session') ?? null, ui: mode };
  }
  if (values.has('--session')) return usage(`--session needs ${REPLAY}`);
  const prompt = values.get('--prompt');
  const file = values.get('--prompt-file');
  if (prompt !== undefined && file !== undefined) return usage('give --prompt or --prompt-file, not both');
  if (prompt === undefined && file === undefined) {
    // Only a lone --mode reached here before the output flags existed; its text stays.
    const newTrigger = requested !== undefined || includeWorkers;
    return usage(newTrigger ? 'a headless run needs --prompt or --prompt-file' : '--mode needs --prompt or --prompt-file');
  }
  const runMode = values.get('--mode') ?? 'code';
  if (!(MODES as readonly string[]).includes(runMode)) return usage(`--mode must be one of ${MODES.join(' | ')}, got '${runMode}'`);
  if (requested !== undefined && !isFormat(requested)) return usage(`--output-format must be one of ${OUTPUT_FORMATS.join(' | ')}, got '${requested}'`);
  if (includeWorkers && format !== 'stream-json') return usage('--include-workers needs --output-format stream-json');
  return {
    kind: 'headless',
    source: prompt !== undefined ? { prompt } : { file: file as string },
    mode: runMode as HeadlessMode,
    format,
    includeWorkers,
    ui: mode,
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
