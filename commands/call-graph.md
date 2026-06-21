---
description: Trace callers, callees, or paths using the call graph
---

Trace function dependencies using the `call_graph` and `call_graph_path` tools.

User input: $ARGUMENTS

Interpret input as follows:
- If input asks for a path, connection, route, chain, or "from X to Y", use `call_graph_path`.
- Default to `direction="callers"` unless input asks for callees/calls/makes calls.
- `name=<function>` or plain text function name sets `name`.
- `symbolId=<id>` is required for `direction="callees"`.
- For path queries, parse `from=<function>`, `to=<function>`, and optional `maxDepth=<number>`.

Execution flow:
1. If input asks for a path and has source/target names, call `call_graph_path` with `{ from, to, maxDepth? }`.
2. If direction is `callers`, call `call_graph` with `{ name, direction: "callers" }`.
3. If direction is `callees` and `symbolId` is present, call `call_graph` with `{ name, direction: "callees", symbolId }`.
4. If direction is `callees` and `symbolId` is missing, first call `call_graph` with `direction="callers"` to get symbol IDs, then ask the user to choose one if multiple are returned.

Examples:
- `/call-graph Database` → callers for `Database`
- `/call-graph callers name=Indexer` → callers for `Indexer`
- `/call-graph callees name=Database symbolId=sym_abc123` → callees for selected symbol
- `/call-graph path from=createOrder to=chargeCard` → shortest known path between the two symbols

If output says no callers found, suggest running `/index force` first.
