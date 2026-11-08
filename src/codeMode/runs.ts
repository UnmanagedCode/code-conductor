// The registry of in-flight run_code processes. A run's token authenticates
// the child's calls back into cc (x-cc-run-token) and its one result delivery;
// it is minted when the run starts and revoked when the process settles.

import { randomBytes } from 'node:crypto';
import {
  RUN_RESULT_MAX_CHARS, RUN_ERROR_MESSAGE_CAP, RUN_ERROR_FIELD_CAP, cutChars, cutResult,
} from './limits.ts';

// What the child posts to /run-result: the function's outcome, already capped.
export interface RunOutcome {
  result: string | null;
  resultChars: number;
  truncated: boolean;
  error?: { name: string; message: string; code?: string; status?: number };
}

// What a delivery may carry, re-applied at cc's boundary: the child caps its own
// outcome, but a program holding the run token can post any body.
export function capOutcome(o: RunOutcome): RunOutcome {
  let { result, truncated, resultChars } = o;
  if (result !== null && result.length > RUN_RESULT_MAX_CHARS) {
    resultChars = Math.max(resultChars, result.length);
    result = cutResult(result, resultChars);
    truncated = true;
  }
  const out: RunOutcome = { result, resultChars, truncated };
  if (o.error) {
    out.error = { name: cutChars(o.error.name, RUN_ERROR_FIELD_CAP), message: cutChars(o.error.message, RUN_ERROR_MESSAGE_CAP) };
    if (o.error.code !== undefined) out.error.code = cutChars(o.error.code, RUN_ERROR_FIELD_CAP);
    if (o.error.status !== undefined) out.error.status = o.error.status;
  }
  return out;
}

export interface RunRegistry {
  open(callerId: string): string;
  get(token: string): { callerId: string } | undefined;
  // The first delivery wins.
  deliver(token: string, outcome: RunOutcome): 'ok' | 'unknown' | 'delivered';
  // Revokes the token and returns the delivered outcome, if any.
  close(token: string): RunOutcome | undefined;
}

export function createRunRegistry(): RunRegistry {
  const runs = new Map<string, { callerId: string; outcome?: RunOutcome }>();
  return {
    open(callerId) {
      const token = randomBytes(32).toString('base64url');
      runs.set(token, { callerId });
      return token;
    },
    get(token) {
      const run = runs.get(token);
      return run ? { callerId: run.callerId } : undefined;
    },
    deliver(token, outcome) {
      const run = runs.get(token);
      if (!run) return 'unknown';
      if (run.outcome) return 'delivered';
      run.outcome = outcome;
      return 'ok';
    },
    close(token) {
      const run = runs.get(token);
      runs.delete(token);
      return run?.outcome;
    },
  };
}
