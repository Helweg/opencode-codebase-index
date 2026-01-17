---
description: Check if the codebase is indexed and ready for semantic search
---

Run the `index_status` tool to check if the codebase index is ready.

This shows:
- Whether the codebase is indexed
- Number of indexed chunks
- Embedding provider and model being used
- Current git branch

No arguments needed - just run `index_status`.

If not indexed, suggest running `/index` to create the index.
