import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { Indexer } from "../indexer/index.js";
import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import { formatCostEstimate } from "../utils/cost.js";
import type { LogLevel } from "../config/schema.js";
import {
  formatProgressTitle,
  formatIndexStats,
  formatStatus,
  calculatePercentage,
  formatCodebasePeek,
  formatHealthCheck,
  formatLogs,
  formatSearchResults,
} from "./utils.js";

const z = tool.schema;

let sharedIndexer: Indexer | null = null;

export function initializeTools(projectRoot: string, config: ParsedCodebaseIndexConfig): void {
  sharedIndexer = new Indexer(projectRoot, config);
}

function getIndexer(): Indexer {
  if (!sharedIndexer) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }
  return sharedIndexer;
}

export const codebase_peek: ToolDefinition = tool({
  description:
    "Quick lookup of code locations by meaning. Returns only metadata (file, line, name, type) WITHOUT code content. Use this first to find WHERE code is, then use Read tool to examine specific files. Saves tokens by not returning full code blocks. Best for: discovery, navigation, finding multiple related locations.",
  args: {
    query: z.string().describe("Natural language description of what code you're looking for."),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(["function", "class", "method", "interface", "type", "enum", "struct", "impl", "trait", "module", "other"]).optional().describe("Filter by code chunk type"),
  },
  async execute(args) {
    const indexer = getIndexer();
    const results = await indexer.search(args.query, args.limit ?? 10, {
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
      metadataOnly: true,
    });

    return formatCodebasePeek(results, args.query);
  },
});

export const index_codebase: ToolDefinition = tool({
  description:
    "Index the codebase for semantic search. Creates vector embeddings of code chunks. Incremental - only re-indexes changed files (~50ms when nothing changed). Run before first codebase_search.",
  args: {
    force: z.boolean().optional().default(false).describe("Force reindex even if already indexed"),
    estimateOnly: z.boolean().optional().default(false).describe("Only show cost estimate without indexing"),
    verbose: z.boolean().optional().default(false).describe("Show detailed info about skipped files and parsing failures"),
  },
  async execute(args, context) {
    const indexer = getIndexer();

    if (args.estimateOnly) {
      const estimate = await indexer.estimateCost();
      return formatCostEstimate(estimate);
    }

    if (args.force) {
      await indexer.clearIndex();
    }

    const stats = await indexer.index((progress) => {
      context.metadata({
        title: formatProgressTitle(progress),
        metadata: {
          phase: progress.phase,
          filesProcessed: progress.filesProcessed,
          totalFiles: progress.totalFiles,
          chunksProcessed: progress.chunksProcessed,
          totalChunks: progress.totalChunks,
          percentage: calculatePercentage(progress),
        },
      });
    });
    return formatIndexStats(stats, args.verbose ?? false);
  },
});

export const index_status: ToolDefinition = tool({
  description:
    "Check the status of the codebase index. Shows whether the codebase is indexed, how many chunks are stored, and the embedding provider being used.",
  args: {},
  async execute() {
    const indexer = getIndexer();
    const status = await indexer.getStatus();
    return formatStatus(status);
  },
});

export const index_health_check: ToolDefinition = tool({
  description:
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
  args: {},
  async execute() {
    const indexer = getIndexer();
    const result = await indexer.healthCheck();

    return formatHealthCheck(result);
  },
});

export const index_metrics: ToolDefinition = tool({
  description:
    "Get metrics and performance statistics for the codebase index. Shows indexing stats, search timings, cache hit rates, and API usage. Requires debug.enabled=true and debug.metrics=true in config.",
  args: {},
  async execute() {
    const indexer = getIndexer();
    const logger = indexer.getLogger();

    if (!logger.isEnabled()) {
      return "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```";
    }

    if (!logger.isMetricsEnabled()) {
      return "Metrics collection is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```";
    }

    return logger.formatMetrics();
  },
});

export const index_logs: ToolDefinition = tool({
  description:
    "Get recent debug logs from the codebase indexer. Shows timestamped log entries with level and category. Requires debug.enabled=true in config.",
  args: {
    limit: z.number().optional().default(20).describe("Maximum number of log entries to return"),
    category: z.enum(["search", "embedding", "cache", "gc", "branch", "general"]).optional().describe("Filter by log category"),
    level: z.enum(["error", "warn", "info", "debug"]).optional().describe("Filter by minimum log level"),
  },
  async execute(args) {
    const indexer = getIndexer();
    const logger = indexer.getLogger();

    if (!logger.isEnabled()) {
      return "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true\n  }\n}\n```";
    }

    let logs;
    if (args.category) {
      logs = logger.getLogsByCategory(args.category, args.limit);
    } else if (args.level) {
      logs = logger.getLogsByLevel(args.level as LogLevel, args.limit);
    } else {
      logs = logger.getLogs(args.limit);
    }

    return formatLogs(logs);
  },
});

export const find_similar: ToolDefinition = tool({
  description:
    "Find code similar to a given snippet. Use for duplicate detection, pattern discovery, or refactoring prep. Paste code and find semantically similar implementations elsewhere in the codebase.",
  args: {
    code: z.string().describe("The code snippet to find similar code for"),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(["function", "class", "method", "interface", "type", "enum", "struct", "impl", "trait", "module", "other"]).optional().describe("Filter by code chunk type"),
    excludeFile: z.string().optional().describe("Exclude results from this file path (useful when searching for duplicates of code from a specific file)"),
  },
  async execute(args) {
    const indexer = getIndexer();
    const results = await indexer.findSimilar(args.code, args.limit, {
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
      excludeFile: args.excludeFile,
    });

    if (results.length === 0) {
      return "No similar code found. Try a different snippet or run index_codebase first.";
    }

    return `Found ${results.length} similar code blocks:\n\n${formatSearchResults(results)}`;
  },
});

export const codebase_search: ToolDefinition = tool({
  description:
    "Search codebase by MEANING, not keywords. Returns full code content. Use when you need to see actual implementation. For just finding WHERE code is (saves ~90% tokens), use codebase_peek instead. For known identifiers like 'validateToken', use grep - it's faster.",
  args: {
    query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
    limit: z.number().optional().default(5).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(["function", "class", "method", "interface", "type", "enum", "struct", "impl", "trait", "module", "other"]).optional().describe("Filter by code chunk type"),
    contextLines: z.number().optional().describe("Number of extra lines to include before/after each match (default: 0)"),
  },
  async execute(args) {
    const indexer = getIndexer();
    const results = await indexer.search(args.query, args.limit ?? 5, {
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
      contextLines: args.contextLines,
    });

    if (results.length === 0) {
      return "No matching code found. Try a different query or run index_codebase first.";
    }

    return `Found ${results.length} results for "${args.query}":\n\n${formatSearchResults(results, "score")}`;
  },
});

export const call_graph: ToolDefinition = tool({
  description:
    "Query the call graph to find callers or callees of a function/method. Use to understand code flow and dependencies between functions.",
  args: {
    name: z.string().describe("Function or method name to query"),
    direction: z.enum(["callers", "callees"]).default("callers").describe("Direction: 'callers' finds who calls this function, 'callees' finds what this function calls"),
    symbolId: z.string().optional().describe("Symbol ID (required for 'callees' direction, returned by previous call_graph queries)"),
  },
  async execute(args) {
    const indexer = getIndexer();
    if (args.direction === "callees") {
      if (!args.symbolId) {
        return "Error: 'symbolId' is required when direction is 'callees'. First use direction='callers' to find the symbol ID.";
      }
      const callees = await indexer.getCallees(args.symbolId);
      if (callees.length === 0) {
        return `No callees found for symbol ${args.symbolId}. The function may not call any other tracked functions.`;
      }
      const formatted = callees.map((e, i) =>
        `[${i + 1}] \u2192 ${e.targetName} (${e.callType}) at line ${e.line}${e.isResolved ? ` [resolved: ${e.toSymbolId}]` : " [unresolved]"}`
      );
      return `${args.name} calls ${callees.length} function(s):\n\n${formatted.join("\n")}`;
    }
    const callers = await indexer.getCallers(args.name);
    if (callers.length === 0) {
      return `No callers found for "${args.name}". It may not be called by any tracked function, or the index needs updating.`;
    }
    const formatted = callers.map((e, i) =>
      `[${i + 1}] \u2190 from symbol ${e.fromSymbolId} (${e.callType}) at line ${e.line}${e.isResolved ? " [resolved]" : " [unresolved]"}`
    );
    return `"${args.name}" is called by ${callers.length} function(s):\n\n${formatted.join("\n")}`;
  },
});
