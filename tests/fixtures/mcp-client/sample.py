# A script using the generated Python client the way a worker's or plugin's
# would: imported from $CONDUCTOR_MCP_CLIENT_DIR, pointed at $CONDUCTOR_MCP_URL
# by default. Prints one JSON line of what each call returned or raised.
# argv: <workspace name> <project> <worktree>. Run by tests/mcp-client.test.mjs.
import json
import os
import sys

sys.path.insert(0, os.environ['CONDUCTOR_MCP_CLIENT_DIR'])
from conductor_client import ConductorClient, ConductorError, CreateWorkspaceResult

workspace, project, worktree = sys.argv[1:4]
client = ConductorClient()


def outcome(fn):
    try:
        return {'returned': fn()}
    except ConductorError as e:
        body_ok = e.body.get('ok') if isinstance(e.body, dict) else None
        return {'raised': {'code': e.code, 'status': e.status, 'bodyOk': body_ok}}


print(json.dumps({
    'success': outcome(lambda: client.create_workspace(name=workspace)),
    'refusal': outcome(lambda: client.describe_playbook(id='no-such')),
    'unknownTool': outcome(lambda: client.call('no_such_tool', {})),
    'badArgs': outcome(lambda: client.call('create_workspace', {})),
    'measured': outcome(lambda: client.sync_worktree(project=project, worktree=worktree)),
    'requiredKeys': sorted(CreateWorkspaceResult.__required_keys__),
}))
