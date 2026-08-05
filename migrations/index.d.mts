// Hand-written declaration for the frozen migrations entrypoint
// (migrations/ stays `.mjs` this round). server.ts imports `runMigrations`
// across the typed/untyped boundary; under nodenext a JS import without a
// declaration is `any` (TS7016). Shape mirrors migrations/index.mjs plus
// each migration module (`name` + `run`) — deliberately not converted.
export interface MigrationResult {
  applied: boolean;
  summary?: unknown;
}

export interface MigrationModule {
  name: string;
  run(opts?: { root: string; log?: (msg: string) => void }): Promise<MigrationResult>;
}

export const ALL: MigrationModule[];

export function runMigrations(opts?: { root: string; log?: (msg: string) => void }): Promise<void>;
