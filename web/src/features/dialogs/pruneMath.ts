// Client-side savings estimate for the Prune dialog, from one
// GET /api/instances/:id/prune/analysis payload. Raw per-turn sums are scaled
// by the session's calibration factor — except image bytes in tool outputs,
// which the server already sizes exactly. Thinking is pruned in every turn, not
// just those before the cut.
export type PruneTurn = {
  thinking: number;
  toolInputTruncatable: number;
  toolInputMinimal: number;
  toolOutput: number;
  toolOutputImage: number;
  exempt: number;
};

export type PruneAnalysis = {
  turnCount: number;
  turns: PruneTurn[];
  encryptedThinking: number;
  contextTokens: number;
  calibration: { factor: number; calibrated: boolean };
};

export type Savings = { thinking: number; toolInputs: number; toolOutputs: number; exempt: number; total: number };

export function computeSavings(a: PruneAnalysis | null, { cut, pruneThinking, minimal }: { cut: number; pruneThinking: boolean; minimal: boolean }): Savings {
  if (!a) return { thinking: 0, toolInputs: 0, toolOutputs: 0, exempt: 0, total: 0 };
  const cal = (raw: number) => Math.round(raw * a.calibration.factor);
  let toolInputs = 0;
  let toolOutputs = 0;
  let image = 0;
  let exempt = 0;
  for (const t of a.turns.slice(0, cut)) {
    toolInputs += minimal ? t.toolInputMinimal : t.toolInputTruncatable;
    toolOutputs += t.toolOutput;
    image += t.toolOutputImage;
    exempt += t.exempt;
  }
  const thinking = pruneThinking ? cal(a.turns.reduce((s, t) => s + t.thinking, 0)) : 0;
  toolInputs = cal(toolInputs);
  toolOutputs = cal(toolOutputs - image) + image;
  return { thinking, toolInputs, toolOutputs, exempt: cal(exempt), total: thinking + toolInputs + toolOutputs };
}

/** The slider's starting cut: ~90% of the turns, at least 1, leaving the last turn. */
export const defaultCut = (turnCount: number) => Math.min(turnCount - 1, Math.max(1, Math.round(turnCount * 0.9)));
