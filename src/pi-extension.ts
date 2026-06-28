import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatCostEstimate } from "./utils/cost.js";
import { formatPrImpact } from "./tools/format-pr-impact.js";
import {
  addKnowledgeBase,
  findSimilarCode,
  getCallGraphData,
  getCallGraphPath,
  getIndexHealthCheck,
  getIndexLogs,
  getIndexMetrics,
  getIndexStatus,
  getPrImpact,
  implementationLookup,
  listKnowledgeBases,
  removeKnowledgeBase,
  runIndexCodebase,
  searchCodebase,
} from "./tools/operations.js";
import {
  formatDefinitionLookup,
  formatHealthCheck,
  formatIndexStats,
  formatSearchResults,
  formatStatus,
} from "./tools/utils.js";

const HOST = "pi" as const;

const ChunkType = Type.Union([
  Type.Literal("function"),
  Type.Literal("class"),
  Type.Literal("method"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("module"),
  Type.Literal("block"),
]);

const RelationshipType = Type.Union([
  Type.Literal("Call"),
  Type.Literal("MethodCall"),
  Type.Literal("Constructor"),
  Type.Literal("Import"),
  Type.Literal("Inherits"),
  Type.Literal("Implements"),
]);

function text(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectRoot(ctx: { cwd?: string } | undefined): string | undefined {
  return ctx?.cwd ?? process.cwd();
}

export default function codebaseIndexPiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "codebase_search",
    label: "Codebase Search",
    description: "Semantic search over the indexed codebase. Describe behavior, not syntax.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language description of what code you're looking for" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default: 10)" })),
      fileType: Type.Optional(Type.String({ description: "Filter by extension, e.g. ts, py, rs" })),
      directory: Type.Optional(Type.String({ description: "Filter by directory path" })),
      chunkType: Type.Optional(ChunkType),
      contextLines: Type.Optional(Type.Number({ description: "Extra lines around each match" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await searchCodebase(projectRoot(ctx), HOST, params.query, params);
      return text(formatSearchResults(results), results);
    },
  });

  pi.registerTool({
    name: "codebase_peek",
    label: "Codebase Peek",
    description: "Semantic search returning only metadata (file, lines, symbol) to save tokens.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
      fileType: Type.Optional(Type.String()),
      directory: Type.Optional(Type.String()),
      chunkType: Type.Optional(ChunkType),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await searchCodebase(projectRoot(ctx), HOST, params.query, { ...params, metadataOnly: true });
      return text(formatSearchResults(results), results);
    },
  });

  pi.registerTool({
    name: "find_similar",
    label: "Find Similar Code",
    description: "Find code similar to a snippet for duplicate detection and pattern discovery.",
    parameters: Type.Object({
      code: Type.String({ description: "Code snippet to compare" }),
      limit: Type.Optional(Type.Number()),
      fileType: Type.Optional(Type.String()),
      directory: Type.Optional(Type.String()),
      chunkType: Type.Optional(ChunkType),
      excludeFile: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await findSimilarCode(projectRoot(ctx), HOST, params.code, params);
      return text(formatSearchResults(results, "similarity"), results);
    },
  });

  pi.registerTool({
    name: "implementation_lookup",
    label: "Implementation Lookup",
    description: "Find likely symbol definitions or implementations by name or natural language.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
      fileType: Type.Optional(Type.String()),
      directory: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await implementationLookup(projectRoot(ctx), HOST, params.query, params);
      return text(formatDefinitionLookup(results, params.query), results);
    },
  });

  pi.registerTool({
    name: "index_codebase",
    label: "Index Codebase",
    description: "Build or refresh the semantic codebase index.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ default: false })),
      estimateOnly: Type.Optional(Type.Boolean({ default: false })),
      verbose: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runIndexCodebase(projectRoot(ctx), HOST, params);
      return result.kind === "estimate"
        ? text(formatCostEstimate(result.estimate), result.estimate)
        : text(formatIndexStats(result.stats, params.verbose ?? false), result.stats);
    },
  });

  pi.registerTool({
    name: "index_status",
    label: "Index Status",
    description: "Check index health and current status.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = await getIndexStatus(projectRoot(ctx), HOST);
      return text(formatStatus(status), status);
    },
  });

  pi.registerTool({
    name: "index_health_check",
    label: "Index Health Check",
    description: "Garbage collect orphaned embeddings/chunks and report health.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await getIndexHealthCheck(projectRoot(ctx), HOST);
      return text(formatHealthCheck(result), result);
    },
  });

  pi.registerTool({
    name: "index_metrics",
    label: "Index Metrics",
    description: "Return collected performance metrics when debug metrics are enabled.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await getIndexMetrics(projectRoot(ctx), HOST);
      return text(result.text, result);
    },
  });

  pi.registerTool({
    name: "index_logs",
    label: "Index Logs",
    description: "Return recent debug logs when debug logging is enabled.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      category: Type.Optional(Type.Union([
        Type.Literal("search"),
        Type.Literal("embedding"),
        Type.Literal("cache"),
        Type.Literal("gc"),
        Type.Literal("branch"),
        Type.Literal("general"),
      ])),
      level: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warn"), Type.Literal("info"), Type.Literal("debug")])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getIndexLogs(projectRoot(ctx), HOST, params);
      return text(result.text, result);
    },
  });

  pi.registerTool({
    name: "call_graph",
    label: "Call Graph",
    description: "Find callers or callees of a function/method in the indexed call graph.",
    parameters: Type.Object({
      name: Type.String(),
      direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees")])),
      symbolId: Type.Optional(Type.String()),
      relationshipType: Type.Optional(RelationshipType),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCallGraphData(projectRoot(ctx), HOST, params);
      return text(JSON.stringify(result, null, 2), result);
    },
  });

  pi.registerTool({
    name: "call_graph_path",
    label: "Call Graph Path",
    description: "Find a call path between two functions/methods.",
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      maxDepth: Type.Optional(Type.Number({ default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCallGraphPath(projectRoot(ctx), HOST, params.from, params.to, params.maxDepth);
      return text(JSON.stringify(result, null, 2), result);
    },
  });

  pi.registerTool({
    name: "pr_impact",
    label: "PR Impact",
    description: "Analyze PR or branch impact through changed symbols and call graph neighborhoods.",
    parameters: Type.Object({
      pr: Type.Optional(Type.Number()),
      branch: Type.Optional(Type.String()),
      maxDepth: Type.Optional(Type.Number({ default: 5 })),
      hubThreshold: Type.Optional(Type.Number({ default: 10 })),
      checkConflicts: Type.Optional(Type.Boolean({ default: false })),
      direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees"), Type.Literal("both")])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getPrImpact(projectRoot(ctx), HOST, params);
      return text(formatPrImpact(result), result);
    },
  });

  pi.registerTool({
    name: "knowledge_base_list",
    label: "List Knowledge Bases",
    description: "List configured knowledge-base paths included in the index.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return text(listKnowledgeBases(projectRoot(ctx), HOST));
    },
  });

  pi.registerTool({
    name: "knowledge_base_add",
    label: "Add Knowledge Base",
    description: "Add a knowledge-base path to the codebase index config.",
    parameters: Type.Object({ path: Type.String({ description: "File or directory path to add" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(addKnowledgeBase(projectRoot(ctx), HOST, params.path));
    },
  });

  pi.registerTool({
    name: "knowledge_base_remove",
    label: "Remove Knowledge Base",
    description: "Remove a knowledge-base path from the codebase index config.",
    parameters: Type.Object({ path: Type.String({ description: "File or directory path to remove" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(removeKnowledgeBase(projectRoot(ctx), HOST, params.path));
    },
  });
}
