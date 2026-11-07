// Typechecked (never run) by tests/mcp-client-generator.test.mjs next to the
// real-registry render of conductor_client.mjs: proves its JSDoc types are
// real — neither `any` (each @ts-expect-error below would then be unused,
// itself an error) nor broken.
import { ConductorClient, ConductorError } from './conductor_client.mjs';

const client = new ConductorClient();
const made = await client.create_workspace({ name: 'scripts' });
/** @type {boolean} */
const added = made.added;
// @ts-expect-error a field create_workspace's result does not have
void made.notAField;
// @ts-expect-error create_workspace's required `name` is missing
await client.create_workspace({});

const sync = await client.sync_worktree({ project: 'p', worktree: 'w' });
if (sync.action === 'commit-required') {
  /** @type {string} */
  const prompt = sync.rebasePrompt;
  void prompt;
}

try { await client.call('no_such_tool', {}); } catch (e) {
  if (e instanceof ConductorError) {
    /** @type {number} */
    const status = e.status;
    void status;
  }
}
void added;
