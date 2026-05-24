// Save user-attached files to the project's / worktree's central-store
// attachments dir and classify image vs. non-image so instances.js can
// build the right content block.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { attachmentsDir } from './worktrees.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isImageType(mediaType) {
  return IMAGE_TYPES.has(String(mediaType || '').toLowerCase());
}

function safeName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return cleaned || 'file';
}

// Persist one attachment to <store>/projects/<project>/[worktrees/<wt>/]
// attachments/<stamp>-<name> and return both the absolute saved path
// and the absolute prompt path Claude reads with the `Read` tool. The
// prompt path is absolute because the file lives outside the agent's
// cwd — relative paths from the worktree would no longer resolve.
export async function saveAttachment(project, worktreeName, { name, dataBase64 }) {
  const dir = attachmentsDir(project, worktreeName ?? null);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}-${safeName(name)}`;
  const abs = path.join(dir, filename);
  await fs.writeFile(abs, Buffer.from(dataBase64, 'base64'));
  return {
    savedPath: abs,
    promptPath: abs,
    filename,
  };
}
