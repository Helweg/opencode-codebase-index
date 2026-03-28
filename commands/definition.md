---
description: Find where a symbol is defined in the codebase
---

Find the authoritative definition of a symbol in the codebase.

User input: $ARGUMENTS

The input is a symbol name or description of what to find the definition of.

Look for optional parameters:
- `limit=N` or "top N" → set limit
- `dir=X` or "in folder X" → set directory filter
- File extensions like ".ts", ".py" → set fileType

Call `implementation_lookup` with the parsed arguments.

Examples:
- `/definition validateToken` → query="validateToken"
- `/definition payment handler` → query="payment handler"
- `/definition createSystem dir=packages/react` → query="createSystem", directory="packages/react"

This prioritizes real implementation files over tests, docs, and examples.
If no definition is found, suggest using `codebase_search` for broader discovery.
