---
description: Quickly find likely code locations without returning full code
---

Search the codebase using `codebase_peek`.

User input: $ARGUMENTS

The first part is the search query. Look for optional parameters:
- `limit=N` or "top N" or "first N" → set limit
- `type=X` or mentions "functions"/"classes"/"methods" → set chunkType
- `dir=X` or "in folder X" → set directory filter
- File extensions like ".ts", "typescript", ".py" → set fileType

Call `codebase_peek` with the parsed arguments.

Examples:
- `/peek authentication logic` → query="authentication logic"
- `/peek error handling limit=5` → query="error handling", limit=5
- `/peek validation functions` → query="validation", chunkType="function"

If the index doesn't exist, run `index_codebase` first.

Return results as concise locations with file paths and line numbers. Suggest reading the returned files or using `codebase_search` when the user needs full code context.
