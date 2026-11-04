// The POST /api/instances body that starts a New conductor: a pristine temp
// session in the hidden conduct project, on the Conductor role. One body for
// both callers — the UI's New conductor (web/src/features/dialogs/conduct.ts,
// always code mode) and the headless runner (src/headless/runner.ts) — so a
// headless root is spawned exactly as the UI spawns one. The project literal is
// CONDUCT_PROJECT_NAME's value (shared/ cannot import src/); a node test pins
// the two equal.

export interface NewConductorSpawnBody {
  project: string;
  role: 'conductor';
  temp: true;
  mode: 'plan' | 'bypassPermissions';
  pristine: true;
}

export function newConductorSpawnBody(mode: 'code' | 'plan'): NewConductorSpawnBody {
  return { project: '.conduct', role: 'conductor', temp: true, mode: mode === 'plan' ? 'plan' : 'bypassPermissions', pristine: true };
}
