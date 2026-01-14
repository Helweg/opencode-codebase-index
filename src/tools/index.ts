import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";

import { Indexer, IndexStats } from "../indexer/index.js";
import { CodebaseIndexConfig } from "../config/schema.js";
import { formatCostEstimate } from "../utils/cost.js";

let sharedIndexer: Indexer | null = null;
let sharedConfig: CodebaseIndexConfig | null = null;

export function initializeTools(projectRoot: string, config: CodebaseIndexConfig): void {
  sharedConfig = config;
  sharedIndexer = new Indexer(projectRoot, config);
}

function getIndexer(): Indexer {
  if (!sharedIndexer) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }
  return sharedIndexer;
}

export const codebase_search: ToolDefinition = tool({
  description:
    "Search codebase by MEANING, not keywords. Use when you don't know exact function/class names. Returns focused results (5-10 files). For known identifiers like 'validateToken' or 'UserService', use grep instead - it's faster and finds all occurrences. Best for: 'find authentication logic', 'code that handles payments', 'error middleware'.",
  args: {
    query: z
      .string()
      .describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of results to return"),
    fileType: z
      .string()
      .optional()
      .describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z
      .string()
      .optional()
      .describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z
      .enum(["function", "class", "method", "interface", "type", "enum", "struct", "impl", "trait", "module", "other"])
      .optional()
      .describe("Filter by code chunk type"),
  },
  async execute(args, ctx) {
    const indexer = getIndexer();
    const results = await indexer.search(args.query, args.limit, {
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
    });

    if (results.length === 0) {
      return "No matching code found. Try a different query or run index_codebase first.";
    }

    const formatted = results.map((r, idx) => {
      const header = r.name
        ? `[${idx + 1}] ${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}-${r.endLine}`
        : `[${idx + 1}] ${r.chunkType} in ${r.filePath}:${r.startLine}-${r.endLine}`;

      return `${header} (score: ${r.score.toFixed(2)})\n\`\`\`\n${r.content}\n\`\`\``;
    });

    return `Found ${results.length} results for "${args.query}":\n\n${formatted.join("\n\n")}`;
  },
});

export const index_codebase: ToolDefinition = tool({
  description:
    "Index the codebase for semantic search. Creates vector embeddings of code chunks. Incremental - only re-indexes changed files (~50ms when nothing changed). Run before first codebase_search.",
  args: {
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Force reindex even if already indexed"),
    estimateOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only show cost estimate without indexing"),
  },
  async execute(args, ctx) {
    const indexer = getIndexer();

    if (args.estimateOnly) {
      const estimate = await indexer.estimateCost();
      return formatCostEstimate(estimate);
    }

    if (args.force) {
      await indexer.clearIndex();
    }

    const stats = await indexer.index();
    return formatIndexStats(stats);
  },
});

export const index_status: ToolDefinition = tool({
  description:
    "Check the status of the codebase index. Shows whether the codebase is indexed, how many chunks are stored, and the embedding provider being used.",
  args: {},
  async execute(args, ctx) {
    const indexer = getIndexer();
    const status = await indexer.getStatus();
    return formatStatus(status);
  },
});

export const index_health_check: ToolDefinition = tool({
  description:
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
  args: {},
  async execute(args, ctx) {
    const indexer = getIndexer();
    const result = await indexer.healthCheck();

    if (result.removed === 0) {
      return "Index is healthy. No stale entries found.";
    }

    const lines = [
      `Health check complete:`,
      `  Removed stale entries: ${result.removed}`,
    ];

    if (result.filePaths.length > 0) {
      lines.push(`  Cleaned paths: ${result.filePaths.join(", ")}`);
    }

    return lines.join("\n");
  },
});

function formatIndexStats(stats: IndexStats): string {
  const lines = [
    `Indexing complete:`,
    `  Files processed: ${stats.totalFiles}`,
    `  Chunks indexed: ${stats.indexedChunks}`,
  ];

  if (stats.failedChunks > 0) {
    lines.push(`  Chunks failed: ${stats.failedChunks}`);
  }

  lines.push(`  Tokens used: ${stats.tokensUsed.toLocaleString()}`);
  lines.push(`  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);

  return lines.join("\n");
}

function formatStatus(status: {
  indexed: boolean;
  vectorCount: number;
  provider: string;
  model: string;
  indexPath: string;
}): string {
  if (!status.indexed) {
    return "Codebase is not indexed. Run index_codebase to create an index.";
  }

  return [
    `Index status:`,
    `  Indexed chunks: ${status.vectorCount.toLocaleString()}`,
    `  Provider: ${status.provider}`,
    `  Model: ${status.model}`,
    `  Location: ${status.indexPath}`,
  ].join("\n");
}
