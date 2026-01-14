---
description: Find code using hybrid approach (semantic + grep)
---

Find code related to: $ARGUMENTS

Strategy:
1. First use `codebase_search` to find semantically related code
2. From the results, identify specific function/class names
3. Use grep to find all occurrences of those identifiers
4. Combine findings into a comprehensive answer

If the semantic index doesn't exist, run `index_codebase` first.
