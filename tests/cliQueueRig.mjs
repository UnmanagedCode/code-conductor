// Shared rig for replaying tests/fixtures/cli-queue/*.stdout.jsonl through real
// Instances wired to a real InstanceManager's idle hub (see the header of
// tests/queued-prompt-pending.test.mjs for the fixtures and how they were derived).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instance } from '../src/instances.ts';

export const FIXTURE_SID = '00000000-0000-4000-8000-000000000000';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-queue');

export const load = async (name) => (await fs.readFile(path.join(FIXTURES, name), 'utf8')).split('\n').filter(Boolean);

// `stream_event:<type>`, or `<type>[:<subtype>][(<hook_event>)]`.
export const kind = (l) => {
  const o = JSON.parse(l);
  return o.type === 'stream_event' ? `stream_event:${o.event.type}`
    : o.type + (o.subtype ? `:${o.subtype}` : '') + (o.hook_event ? `(${o.hook_event})` : '');
};
export const indexesOf = (lines, k) => lines.flatMap((l, i) => (kind(l) === k ? [i] : []));

// A fixture line re-addressed to another hook event, or nested under a subagent.
export const asHook = (line, hookEvent) => JSON.stringify({ ...JSON.parse(line), hook_name: hookEvent, hook_event: hookEvent });
export const nested = (line) => JSON.stringify({ ...JSON.parse(line), parent_tool_use_id: 'toolu_nested' });

export function makeInstance(id) {
  const inst = new Instance({
    id, project: 'test-project', cwd: '/nonexistent-cwd',
    mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
  });
  inst.sessionId = `${id}-sid`;
  // The fixtures' session id: their `system/init` is a turn opener, not a rotation.
  inst.backingSessionId = FIXTURE_SID;
  inst.proc = { pid: 1, stdin: { writable: true, write() {} } };
  return inst;
}

// Bridges exactly as InstanceManager.create() does.
export function wire(instances, inst) {
  instances.byId.set(inst.id, inst);
  inst.on('event', (ev, replayed) => instances.emit('event', { id: inst.id, ev, replayed: replayed === true }));
  inst.on('turn_start', () => instances._idleHub.onTurnStart(inst.id));
  inst.on('prompts_unblocked', () => instances._idleHub.onPromptsUnblocked(inst.id));
}

export const feed = (inst, lines) => { for (const l of lines) inst._handleStdoutLine(l); };

// The status at each emission of `name` by `inst`, from now on.
export const countEmits = (inst, name) => { const seen = []; inst.on(name, () => seen.push(inst.status)); return seen; };

export const microtasks = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
