// The text-format tools/list is the agent-facing catalog: every description is
// system-prompt text a session pays for, so the application-first /mcp must
// leave it byte-identical. The fixture was captured from main's tools/list on a
// bare router with every capability on, with ONE edit — the set_idle_timeout
// sentence naming caller identity now names the `/mcp/<sessionId>` path
// instead of the `?caller=` query parameter — and the event log's two
// description edits: send_prompt's `stage` no longer says a declared self-loop
// is recorded, and playbook_state describes `history` as event-log rows and
// `stageHistory` as stage changes (docs/event-log.md) — and the one added entry,
// `run_code` (docs/code-mode.md), last in the registry — and project_bash's
// `outputMayBeIncomplete?` metadata key and its sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-tools-list.text.json');

test('text-format tools/list is byte-identical to the captured catalog', async () => {
  const router = buildMcpRouter({
    instances: null, pluginHost: null,
    playbookGate: createPlaybookGate({ instances: null }),
    capabilities: { remoteSystems: true, fuseUnion: true, voice: true },
  });
  const app = express();
  app.use('/mcp', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp?format=text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await res.json();
    assert.equal(JSON.stringify(body.result), readFileSync(FIXTURE, 'utf8'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
