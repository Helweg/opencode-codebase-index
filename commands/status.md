---
description: Check if the codebase is indexed and ready for semantic search
---

Run the `index_status` tool to check if the codebase index is ready.

This shows:
- Whether the codebase is indexed
- Number of indexed chunks
- Embedding provider and model being used
- Current git branch
- Failed embedding batches or compatibility warnings that explain why search is not ready

No arguments needed - just run `index_status`.

If not indexed:
- suggest running `/index` when no index exists yet
- if status reports failed embedding batches, tell the user to fix the provider/auth issue and rerun `/index` normally
- if status reports provider/model incompatibility, tell the user to run `/index force` for a full rebuild
