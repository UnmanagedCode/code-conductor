// Stable per-process boot identity, minted once at module load. Exposed via
// GET /api/health so the client restart flow can tell the replacement process
// apart from the still-draining old one: on a "Resume after restart" the old
// server keeps HTTP/WS up for the whole ≤60 s drain, so a plain "is it up?"
// poll would reload against the dying old process. The client captures this id
// before POSTing the restart and polls until it observes a DIFFERENT one.
import { randomUUID } from 'node:crypto';

export const BOOT_ID = randomUUID();
