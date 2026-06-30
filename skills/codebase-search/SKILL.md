---
name: codebase-search
description: Semantic code and documentation search by meaning for Pi and Codex workflows. Use codebase_peek to find WHERE code is first, then codebase_search for implementation details.
---

# Codebase Search Skill

Use this skill when you need local repository knowledge before web lookup.

## Core workflow

1. `codebase_peek(query, ...)` to find likely locations quickly with metadata-only results.
2. `codebase_search(query, ...)` when you need full code context.
3. `call_graph(name, direction)` when you need callers/callees after locating a symbol.
4. `find_similar(code)` for duplicate patterns and refactor planning.
5. `implementation_lookup(query)` when you need the authoritative definition location.

If results are weak, run `index_status` (check readiness) and `index_codebase`.

## Tool Priority

- `codebase_peek` for discovery (fastest, cheap tokens).
- `codebase_search` for exact implementation review.
- `find_similar` for pattern matching and duplication.
- `call_graph` and `call_graph_path` for execution flow.
- `index_codebase` (force/estimate/verbose) for first-time or stale indexes.
- `index_status`, `index_health_check`, `index_metrics`, `index_logs` for operational checks.

## Suggested Commands

1. `codebase_peek("payment processing flow")`
2. `codebase_search("payment processing flow")`
3. `call_graph("chargeCard", "callees")`
4. `find_similar("function validate(data)")`
5. `implementation_lookup("validate")`

## Additional Notes

- Use `grep` for exact identifiers and tiny, deterministic lookups.
- Use `websearch` only when local tools return no results and docs are likely missing.
- Prefer `codebase_peek` before `codebase_search` to avoid high token usage.
