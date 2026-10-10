// Which spec files share a booted cc. a1, a2, b, d1 and d2 run in path order
// (workers: 1), each records the cc it got, and z-check reads the records.
// Workers share no memory, hence the per-project file.
import fs from 'node:fs';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import type { Cc } from '../harness/fixtures.ts';

export type ServerRecord = { label: string; root: string; port: number; worker: number };

const logOf = (testInfo: TestInfo) => path.join(testInfo.project.outputDir, `server-key-${testInfo.project.name}.jsonl`);

export function record(testInfo: TestInfo, label: string, cc: Cc, { first = false } = {}): void {
  const rec: ServerRecord = { label, root: cc.dirs.root, port: cc.port, worker: process.pid };
  fs.mkdirSync(path.dirname(logOf(testInfo)), { recursive: true });
  (first ? fs.writeFileSync : fs.appendFileSync)(logOf(testInfo), JSON.stringify(rec) + '\n');
}

export function records(testInfo: TestInfo): Record<string, ServerRecord> {
  const lines = fs.readFileSync(logOf(testInfo), 'utf8').trim().split('\n');
  return Object.fromEntries(lines.map((l) => JSON.parse(l) as ServerRecord).map((r) => [r.label, r]));
}
