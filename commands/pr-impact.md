---
description: Analyze PR or branch impact using the call graph
---

Analyze the impact of a pull request or branch before merging.

User input: $ARGUMENTS

Interpret input as follows:
- `pr=N` or plain number at the start → set `pr`
- `branch=<name>` or plain branch name → set `branch`
- `maxDepth=N` → set max traversal depth
- `hubThreshold=N` → set hub node threshold
- `checkConflicts` or `conflicts` → set `checkConflicts=true`

Call `pr_impact` with the parsed arguments.

Examples:
- `/pr-impact 42` → pr=42
- `/pr-impact branch=feature/auth` → branch="feature/auth"
- `/pr-impact branch=feature/x maxDepth=3 checkConflicts` → branch="feature/x", maxDepth=3, checkConflicts=true

If the index doesn't exist, run `index_codebase` first.
