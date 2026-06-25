---
description: Generate temporal HTML call graph visualization
---

Generate an interactive temporal call graph visualization that starts with recent movement/onboarding context, then supports module overview, symbol exploration, hotspots, and cycles.

User input: $ARGUMENTS

Parse input for optional parameters:
- Plain text → directory filter (e.g., `/visualize src/services`)
- `max=N` or "limit N" → sets maxNodes
- `orphans` or `include-orphans` → sets includeOrphans=true
- No input → visualize recent code movement plus entire call graph

Call `index_visualize` with parsed parameters.

Examples:
- `/visualize` → temporal onboarding view with changes, modules, symbols, hotspots, and cycles
- `/visualize src/tools` → only symbols in src/tools/
- `/visualize max=1000` → limit to 1000 nodes
- `/visualize src/indexer orphans` → include disconnected nodes

If the index doesn't exist, run `index_codebase` first.

Return the generated file path and open instructions.

Terminology:
- Modules are path-based code areas, such as `src/tools` or `native`.
- Symbols are indexed named code units, such as functions, methods, classes, or Rust modules.
- Cycles are loops where code can eventually call or depend back on itself.
