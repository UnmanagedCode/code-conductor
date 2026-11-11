// The child process of one run_code call: reads the program from stdin, runs
// it as an async function body with `cc` in scope, and posts the outcome to
// cc's /run-result. Anything the program prints is the run's `logs`.

import {
  createCc, serializeOutcome, RUN_TOKEN_HEADER, RUN_URL_ENV, RUN_TOKEN_ENV, RUN_MEMBERS_ENV, type SerializedOutcome,
} from './runtimeApi.ts';

const url = process.env[RUN_URL_ENV];
const token = process.env[RUN_TOKEN_ENV];
if (!url || !token) {
  console.error(`run_code runtime: ${RUN_URL_ENV} and ${RUN_TOKEN_ENV} are required`);
  process.exit(2);
}

// `{id: [names]}` from the server; absent means no plugin members.
function readMembers(): Map<string, Set<string>> {
  const raw = process.env[RUN_MEMBERS_ENV];
  const out = new Map<string, Set<string>>();
  if (raw === undefined || raw === '') return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object');
    for (const [id, names] of Object.entries(parsed)) {
      if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) throw new TypeError(`'${id}' is not a list of names`);
      out.set(id, new Set(names as string[]));
    }
  } catch (e) {
    console.error(`run_code runtime: ${RUN_MEMBERS_ENV} is malformed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const flush = (s: NodeJS.WriteStream) => new Promise<void>(r => { s.write('', () => r()); });

let finished = false;
async function finish(outcome: SerializedOutcome): Promise<never> {
  if (!finished) {
    finished = true;
    try {
      const res = await fetch(`${url}/run-result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: token as string },
        body: JSON.stringify(outcome),
      });
      if (res.status !== 204) console.error(`run_code runtime: result delivery refused (HTTP ${res.status}): ${await res.text()}`);
    } catch (e) {
      console.error('run_code runtime: result delivery failed:', e);
    }
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
  }
  // Exit explicitly so a program's leftover timers cannot print after the result.
  process.exit(outcome.error ? 1 : 0);
}

process.on('uncaughtException', (e) => { void finish(serializeOutcome({ thrown: e })); });
process.on('unhandledRejection', (e) => { void finish(serializeOutcome({ thrown: e })); });

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (cc: unknown) => Promise<unknown>;
try {
  const fn = new AsyncFunction('cc', await readStdin());
  const value = await fn(createCc({ url: url as string, token: token as string, members: readMembers() }));
  await finish(serializeOutcome({ value }));
} catch (e) {
  await finish(serializeOutcome({ thrown: e }));
}
