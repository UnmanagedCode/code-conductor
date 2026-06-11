// Migration 0006: forward marker for the cost-tracking feature.
//
// cost-tracking appends one JSON line per turn_end to
// <store>/costs.jsonl. The file is created lazily on first write
// (appendCostRow ensures the directory exists via mkdir), so no
// on-disk action is needed here. This stub exists to document the
// schema version at which cost tracking was introduced and to
// reserve the migration slot.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

export const name = '0006-init-cost-tracking';

// eslint-disable-next-line no-unused-vars
export async function run({ root, log = console.log } = {}) {
  return { applied: false };
}
