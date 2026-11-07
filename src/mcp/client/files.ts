// Writes the generated /mcp clients into <store>/mcp-client/ (mcpClientDir),
// from the registry this host serves. Called at every boot before the server
// listens (server.ts startHolding), so no worker, plugin or script can see a
// client older than the running server.

import path from 'node:path';
import { capableTools } from '../tools.ts';
import { mcpClientDir, writeFileAtomic } from '../../projects.ts';
import type { PlatformCapabilities } from '../../platform/platform.ts';
import { renderPythonClient } from './python.ts';
import { renderNodeClient } from './node.ts';

export const MCP_CLIENT_FILES = { python: 'conductor_client.py', node: 'conductor_client.mjs' } as const;

export async function writeMcpClientFiles(capabilities: PlatformCapabilities): Promise<void> {
  const tools = capableTools('json', capabilities);
  const dir = mcpClientDir();
  await writeFileAtomic(path.join(dir, MCP_CLIENT_FILES.python), renderPythonClient(tools));
  await writeFileAtomic(path.join(dir, MCP_CLIENT_FILES.node), renderNodeClient(tools));
}
