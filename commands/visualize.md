---
description: Generate interactive HTML call graph visualization
---

Generate an interactive force-directed visualization of the call graph.

User input: $ARGUMENTS

Parse input for optional parameters:
- Plain text → directory filter (e.g., `/visualize src/services`)
- `max=N` or "limit N" → sets maxNodes
- `orphans` or `include-orphans` → sets includeOrphans=true
- No input → visualize entire call graph

Call `index_visualize` with parsed parameters.

Examples:
- `/visualize` → full call graph
- `/visualize src/tools` → only symbols in src/tools/
- `/visualize max=1000` → limit to 1000 nodes
- `/visualize src/indexer orphans` → include disconnected nodes

If the index doesn't exist, run `index_codebase` first.

Return the generated file path and open instructions.
