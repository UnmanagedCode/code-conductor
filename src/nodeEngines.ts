import { readFileSync } from 'node:fs';

// Only the `>=MAJOR[.MINOR[.PATCH]]` shape package.json uses is understood; any
// other range yields a warning that it cannot be checked, so a range change
// fails loudly instead of switching the check off.
const MIN_RANGE = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

// Null when `version` satisfies `range`, else the warning to print.
export function nodeEnginesMismatch(version: string, range: string): string | null {
  const m = MIN_RANGE.exec(range.trim());
  if (!m) return `package.json engines.node "${range}" is a range this check cannot read; Node ${version} is unchecked`;
  const want = [m[1], m[2], m[3]].map(n => Number(n ?? 0));
  const have = version.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > want[i]) return null;
    if ((have[i] ?? 0) < want[i]) {
      return `Node ${version} does not satisfy package.json engines.node "${range}"; self-update never updates Node; install a Node that satisfies it`;
    }
  }
  return null;
}

export function warnIfNodeUnsupported(): void {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines?: { node?: string } };
  const msg = nodeEnginesMismatch(process.versions.node, pkg.engines?.node ?? '');
  if (msg) console.warn(msg);
}
