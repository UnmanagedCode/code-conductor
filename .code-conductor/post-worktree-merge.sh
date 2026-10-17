#!/usr/bin/env bash
# cc's own post-merge step — the decision lives in src/webPostMerge.ts.
set -e
exec node src/webPostMergeMain.ts "${CC_PRE_MERGE_SHA:?}" "${CC_POST_MERGE_SHA:?}"
