---
description: Search codebase by meaning using semantic search
---

Search the codebase using semantic search.

User input: $ARGUMENTS

The first part is the search query. Look for optional parameters:
- `limit=N` or "top N" or "first N" → set limit
- `type=X` or mentions "functions"/"classes"/"methods" → set chunkType
- `dir=X` or "in folder X" → set directory filter
- File extensions like ".ts", "typescript", ".py" → set fileType

Call `codebase_search` with the parsed arguments.

Examples:
- `/search authentication logic` → query="authentication logic"
- `/search error handling limit=5` → query="error handling", limit=5
- `/search validation functions` → query="validation", chunkType="function"

If the index doesn't exist, run `index_codebase` first.

Return results with file paths and line numbers.
