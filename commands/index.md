---
description: Index the codebase for semantic search
---

Run the `index_codebase` tool with these settings:

User input: $ARGUMENTS

Parse the input and set tool arguments:
- force=true if input contains "force"
- estimateOnly=true if input contains "estimate" 
- verbose=false (default, for token efficiency)
- verbose=true if input contains "verbose" (for detailed output)

Examples:
- `/index` → force=false, estimateOnly=false, verbose=false
- `/index force` → force=true, estimateOnly=false, verbose=false
- `/index estimate` → force=false, estimateOnly=true, verbose=false
- `/index verbose` → force=false, estimateOnly=false, verbose=true

IMPORTANT: You MUST pass the parsed arguments to `index_codebase`. Do not ignore them.

Show final statistics including files processed, chunks indexed, tokens used, and duration.
