// public/toolName.js — the display parse of a tool's wire name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { formatToolName, toolNamePlain } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'toolName.js')).href);

function check(t, raw, kind, chip, label) {
  return t.test(raw ?? String(raw), () => {
    assert.deepEqual(formatToolName(raw), { raw, kind, chip, label });
    assert.equal(toolNamePlain(raw), chip ? `${chip}: ${label}` : label);
  });
}

test('formatToolName: three segments under cc\'s server read as a core tool', async (t) => {
  await check(t, 'mcp__code-conductor__spawn_instance', 'cc', 'cc', 'Spawn instance');
});

test('formatToolName: four segments read as plugin + tool, with a leading code- stripped', async (t) => {
  await check(t, 'mcp__code-conductor__code-kanban__move_card', 'plugin', 'kanban', 'Move card');
  await check(t, 'mcp__code-conductor__code-wiki__read_index', 'plugin', 'wiki', 'Read index');
});

test('formatToolName: a plugin id without code- is the chip verbatim', async (t) => {
  await check(t, 'mcp__code-conductor__acme-tools__run', 'plugin', 'acme-tools', 'Run');
});

test('formatToolName: the plugin id ends at the first __ and the tool keeps the remainder', async (t) => {
  await check(t, 'mcp__code-conductor__code-kanban__a__b', 'plugin', 'kanban', 'A b');
});

test('formatToolName: a third-party server splits on __, never _', async (t) => {
  await check(t, 'mcp__claude_ai_Claude_Docs__batch', 'mcp', 'Claude Docs', 'Batch');
  await check(t, 'mcp__github__create_issue', 'mcp', 'github', 'Create issue');
});

test('formatToolName: built-ins render verbatim with no chip', async (t) => {
  for (const raw of ['Bash', 'Read', 'ToolSearch']) await check(t, raw, 'builtin', null, raw);
});

test('formatToolName: an unparseable mcp name renders verbatim', async (t) => {
  for (const raw of [
    'mcp__x', 'mcp__', 'mcp____tool', 'mcp__code-conductor__',
    'mcp__code-conductor__code-kanban__', 'mcp__code-conductor____x',
    'mcp__code-conductor__code-kanban_____',
  ]) await check(t, raw, 'builtin', null, raw);
});

test('formatToolName: a non-string name falls back to "tool"', async (t) => {
  await check(t, undefined, 'builtin', null, 'tool');
  await check(t, null, 'builtin', null, 'tool');
});

test('formatToolName: sentence case uppercases the first letter and never lowercases the rest', async (t) => {
  await check(t, 'mcp__github__get_URL', 'mcp', 'github', 'Get URL');
});
