#!/usr/bin/env bash
# cc's own post-merge step — the decision lives in src/webPostMerge.ts.
# CC_SERVER_NODE is the node running cc; `node` on PATH only when it is unset.
set -e
exec "${CC_SERVER_NODE:-node}" src/webPostMergeMain.ts "${CC_PRE_MERGE_SHA:?}" "${CC_POST_MERGE_SHA:?}"
