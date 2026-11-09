// Where one convention scope's committed fragment files live:
// `conventions/<scope>/` in this checkout, or `$CC_CONVENTIONS_DIR/<scope>` when
// that is set. Read per call, so a test can point the scope modules at a temp
// copy of the tree (docs/architecture.md → Testing).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIPPED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conventions');

export type ConventionScope = 'conductor' | 'workspace' | 'project';

export function conventionsDir(scope: ConventionScope): string {
  return path.join(process.env.CC_CONVENTIONS_DIR || SHIPPED, scope);
}
