---
description: Fully rebuild the codebase index from scratch
---

Run the `index_codebase` tool with `force=true` to rebuild the index from scratch.

User input: $ARGUMENTS

Parse the input and set tool arguments:
- force=true always
- estimateOnly=false always
- verbose=false (default, for token efficiency)
- verbose=true if input contains "verbose" (for detailed output)

Examples:
- `/reindex` → force=true, estimateOnly=false, verbose=false
- `/reindex verbose` → force=true, estimateOnly=false, verbose=true

IMPORTANT: You MUST call `index_codebase` with `force=true`.

Show final statistics including files processed, chunks indexed, tokens used, and duration.

If indexing completes but the codebase still is not ready, tell the user to run `/status` next.
- If `/status` reports failed embedding batches, fix the provider/auth issue and rerun `/index` normally.
- If `/status` reports provider/model incompatibility again after a rebuild, surface that clearly as an unexpected issue.
