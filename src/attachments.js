// Save user-attached files to a per-worktree dir and classify image
// vs. non-image so instances.js can build the right content block.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { attachmentsDir, ORCH_DOTDIR } from './worktrees.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isImageType(mediaType) {
  return IMAGE_TYPES.has(String(mediaType || '').toLowerCase());
}

function safeName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return cleaned || 'file';
}

// Persist one attachment to <cwd>/.claude-orch-app/attachments/<stamp>-<name>
// and return both the absolute path and the worktree-relative path the
// model can use with the Read tool.
export async function saveAttachment(cwd, { name, dataBase64 }) {
  const dir = attachmentsDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}-${safeName(name)}`;
  const abs = path.join(dir, filename);
  await fs.writeFile(abs, Buffer.from(dataBase64, 'base64'));
  return {
    savedPath: abs,
    relPath: path.posix.join(ORCH_DOTDIR, 'attachments', filename),
    filename,
  };
}
