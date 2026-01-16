---
description: Find code using hybrid approach (semantic + grep)
---

Find code using both semantic search and grep.

User input: $ARGUMENTS

Strategy:
1. Use `codebase_search` to find semantically related code
2. Identify specific function/class/variable names from results
3. Use grep to find all occurrences of those identifiers
4. Combine into a comprehensive answer

Parse optional parameters from input:
- `limit=N` → limit semantic results
- `type=X` or "functions"/"classes" → filter chunk type
- `dir=X` → filter directory

Examples:
- `/find error handling middleware`
- `/find payment validation type=function`
- `/find user auth in src/services`

If no index exists, run `index_codebase` first.
