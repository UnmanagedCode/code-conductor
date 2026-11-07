// A script using the generated Node client the way a worker's or plugin's
// would: imported from $CONDUCTOR_MCP_CLIENT_DIR, pointed at $CONDUCTOR_MCP_URL
// by default. Prints one JSON line of what each call returned or raised.
// argv: <workspace name> <project> <worktree>. Run by tests/mcp-client.test.mjs.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { ConductorClient, ConductorError } = await import(
  pathToFileURL(path.join(process.env.CONDUCTOR_MCP_CLIENT_DIR, 'conductor_client.mjs')).href);
const [workspace, project, worktree] = process.argv.slice(2);
const client = new ConductorClient();

async function outcome(fn) {
  try { return { returned: await fn() }; } catch (e) {
    if (!(e instanceof ConductorError)) throw e;
    return { raised: { code: e.code, status: e.status, bodyOk: e.body?.ok ?? null } };
  }
}

console.log(JSON.stringify({
  success: await outcome(() => client.create_workspace({ name: workspace })),
  refusal: await outcome(() => client.describe_playbook({ id: 'no-such' })),
  unknownTool: await outcome(() => client.call('no_such_tool', {})),
  badArgs: await outcome(() => client.call('create_workspace', {})),
  measured: await outcome(() => client.sync_worktree({ project, worktree })),
  // Optional arguments: an all-optional call sends nothing; null is sent.
  listed: await outcome(() => client.list_sessions()),
  nullSent: await outcome(() => client.list_sessions({ project: null })),
  assigned: await outcome(() => client.set_project_workspace({ project, workspace })),
  cleared: await outcome(() => client.set_project_workspace({ project, workspace: null })),
  readBack: (await client.list_projects()).projects.find(p => p.name === project)?.workspace,
}));
