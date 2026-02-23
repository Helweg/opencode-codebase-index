import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Indexer, type IndexStats } from "./indexer/index.js";
import type { ParsedCodebaseIndexConfig, LogLevel } from "./config/schema.js";
import { formatCostEstimate } from "./utils/cost.js";

const MAX_CONTENT_LINES = 30;

function truncateContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTENT_LINES) return content;
  return (
    lines.slice(0, MAX_CONTENT_LINES).join("\n") +
    `\n// ... (${lines.length - MAX_CONTENT_LINES} more lines)`
  );
}

function formatIndexStats(stats: IndexStats, verbose: boolean = false): string {
  const lines: string[] = [];

  if (stats.indexedChunks === 0 && stats.removedChunks === 0) {
    lines.push(`Indexed. ${stats.totalFiles} files processed, ${stats.existingChunks} code chunks already up to date.`);
  } else if (stats.indexedChunks === 0) {
    lines.push(`Indexed. ${stats.totalFiles} files, removed ${stats.removedChunks} stale chunks, ${stats.existingChunks} chunks remain.`);
  } else {
    let main = `Indexed. ${stats.totalFiles} files processed, ${stats.indexedChunks} new chunks embedded.`;
    if (stats.existingChunks > 0) {
      main += ` ${stats.existingChunks} unchanged chunks skipped.`;
    }
    lines.push(main);

    if (stats.removedChunks > 0) {
      lines.push(`Removed ${stats.removedChunks} stale chunks.`);
    }

    if (stats.failedChunks > 0) {
      lines.push(`Failed: ${stats.failedChunks} chunks.`);
    }

    lines.push(`Tokens: ${stats.tokensUsed.toLocaleString()}, Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
  }

  if (verbose) {
    if (stats.skippedFiles.length > 0) {
      const tooLarge = stats.skippedFiles.filter(f => f.reason === "too_large");
      const excluded = stats.skippedFiles.filter(f => f.reason === "excluded");
      const gitignored = stats.skippedFiles.filter(f => f.reason === "gitignore");

      lines.push("");
      lines.push(`Skipped files: ${stats.skippedFiles.length}`);
      if (tooLarge.length > 0) {
        lines.push(`  Too large (${tooLarge.length}): ${tooLarge.slice(0, 5).map(f => f.path).join(", ")}${tooLarge.length > 5 ? "..." : ""}`);
      }
      if (excluded.length > 0) {
        lines.push(`  Excluded (${excluded.length}): ${excluded.slice(0, 5).map(f => f.path).join(", ")}${excluded.length > 5 ? "..." : ""}`);
      }
      if (gitignored.length > 0) {
        lines.push(`  Gitignored (${gitignored.length}): ${gitignored.slice(0, 5).map(f => f.path).join(", ")}${gitignored.length > 5 ? "..." : ""}`);
      }
    }

    if (stats.parseFailures.length > 0) {
      lines.push("");
      lines.push(`Files with no extractable chunks (${stats.parseFailures.length}): ${stats.parseFailures.slice(0, 10).join(", ")}${stats.parseFailures.length > 10 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

function formatStatus(status: {
  indexed: boolean;
  vectorCount: number;
  provider: string;
  model: string;
  indexPath: string;
  currentBranch: string;
  baseBranch: string;
}): string {
  if (!status.indexed) {
    return "Codebase is not indexed. Run index_codebase to create an index.";
  }

  const lines = [
    `Index status:`,
    `  Indexed chunks: ${status.vectorCount.toLocaleString()}`,
    `  Provider: ${status.provider}`,
    `  Model: ${status.model}`,
    `  Location: ${status.indexPath}`,
  ];

  if (status.currentBranch !== "default") {
    lines.push(`  Current branch: ${status.currentBranch}`);
    lines.push(`  Base branch: ${status.baseBranch}`);
  }

  return lines.join("\n");
}

const CHUNK_TYPE_ENUM = [
  "function", "class", "method", "interface", "type",
  "enum", "struct", "impl", "trait", "module", "other",
] as const;

export function createMcpServer(projectRoot: string, config: ParsedCodebaseIndexConfig): McpServer {
  const server = new McpServer({
    name: "opencode-codebase-index",
    version: "0.5.0",
  });

  const indexer = new Indexer(projectRoot, config);
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (!initialized) {
      await indexer.initialize();
      initialized = true;
    }
  }

  // --- Tools ---

  server.tool(
    "codebase_search",
    "Search codebase by MEANING, not keywords. Returns full code content. For just finding WHERE code is (saves ~90% tokens), use codebase_peek instead.",
    {
      query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
      limit: z.number().optional().default(5).describe("Maximum number of results to return"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: z.enum(CHUNK_TYPE_ENUM).optional().describe("Filter by code chunk type"),
      contextLines: z.number().optional().describe("Number of extra lines to include before/after each match (default: 0)"),
    },
    async (args) => {
      await ensureInitialized();
      const results = await indexer.search(args.query, args.limit ?? 5, {
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        contextLines: args.contextLines,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching code found. Try a different query or run index_codebase first." }] };
      }

      const formatted = results.map((r, idx) => {
        const header = r.name
          ? `[${idx + 1}] ${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}-${r.endLine}`
          : `[${idx + 1}] ${r.chunkType} in ${r.filePath}:${r.startLine}-${r.endLine}`;
        return `${header} (score: ${r.score.toFixed(2)})\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
      });

      return { content: [{ type: "text", text: `Found ${results.length} results for "${args.query}":\n\n${formatted.join("\n\n")}` }] };
    },
  );

  server.tool(
    "codebase_peek",
    "Quick lookup of code locations by meaning. Returns only metadata (file, line, name, type) WITHOUT code content. Saves ~90% tokens vs codebase_search.",
    {
      query: z.string().describe("Natural language description of what code you're looking for."),
      limit: z.number().optional().default(10).describe("Maximum number of results to return"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: z.enum(CHUNK_TYPE_ENUM).optional().describe("Filter by code chunk type"),
    },
    async (args) => {
      await ensureInitialized();
      const results = await indexer.search(args.query, args.limit ?? 10, {
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        metadataOnly: true,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching code found. Try a different query or run index_codebase first." }] };
      }

      const formatted = results.map((r, idx) => {
        const location = `${r.filePath}:${r.startLine}-${r.endLine}`;
        const name = r.name ? `"${r.name}"` : "(anonymous)";
        return `[${idx + 1}] ${r.chunkType} ${name} at ${location} (score: ${r.score.toFixed(2)})`;
      });

      return { content: [{ type: "text", text: `Found ${results.length} locations for "${args.query}":\n\n${formatted.join("\n")}\n\nUse Read tool to examine specific files.` }] };
    },
  );

  server.tool(
    "index_codebase",
    "Index the codebase for semantic search. Creates vector embeddings of code chunks. Incremental - only re-indexes changed files. Run before first codebase_search.",
    {
      force: z.boolean().optional().default(false).describe("Force reindex even if already indexed"),
      estimateOnly: z.boolean().optional().default(false).describe("Only show cost estimate without indexing"),
      verbose: z.boolean().optional().default(false).describe("Show detailed info about skipped files and parsing failures"),
    },
    async (args) => {
      await ensureInitialized();

      if (args.estimateOnly) {
        const estimate = await indexer.estimateCost();
        return { content: [{ type: "text", text: formatCostEstimate(estimate) }] };
      }

      if (args.force) {
        await indexer.clearIndex();
      }

      const stats = await indexer.index();
      return { content: [{ type: "text", text: formatIndexStats(stats, args.verbose ?? false) }] };
    },
  );

  server.tool(
    "index_status",
    "Check the status of the codebase index. Shows whether the codebase is indexed, how many chunks are stored, and the embedding provider being used.",
    {},
    async () => {
      await ensureInitialized();
      const status = await indexer.getStatus();
      return { content: [{ type: "text", text: formatStatus(status) }] };
    },
  );

  server.tool(
    "index_health_check",
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
    {},
    async () => {
      await ensureInitialized();
      const result = await indexer.healthCheck();

      if (result.removed === 0 && result.gcOrphanEmbeddings === 0 && result.gcOrphanChunks === 0) {
        return { content: [{ type: "text", text: "Index is healthy. No stale entries found." }] };
      }

      const lines = [`Health check complete:`];

      if (result.removed > 0) {
        lines.push(`  Removed stale entries: ${result.removed}`);
      }

      if (result.gcOrphanEmbeddings > 0) {
        lines.push(`  Garbage collected orphan embeddings: ${result.gcOrphanEmbeddings}`);
      }

      if (result.gcOrphanChunks > 0) {
        lines.push(`  Garbage collected orphan chunks: ${result.gcOrphanChunks}`);
      }

      if (result.filePaths.length > 0) {
        lines.push(`  Cleaned paths: ${result.filePaths.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "index_metrics",
    "Get metrics and performance statistics for the codebase index. Requires debug.enabled=true and debug.metrics=true in config.",
    {},
    async () => {
      await ensureInitialized();
      const logger = indexer.getLogger();

      if (!logger.isEnabled()) {
        return { content: [{ type: "text", text: "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```" }] };
      }

      if (!logger.isMetricsEnabled()) {
        return { content: [{ type: "text", text: "Metrics collection is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```" }] };
      }

      return { content: [{ type: "text", text: logger.formatMetrics() }] };
    },
  );

  server.tool(
    "index_logs",
    "Get recent debug logs from the codebase indexer. Requires debug.enabled=true in config.",
    {
      limit: z.number().optional().default(20).describe("Maximum number of log entries to return"),
      category: z.enum(["search", "embedding", "cache", "gc", "branch", "general"]).optional().describe("Filter by log category"),
      level: z.enum(["error", "warn", "info", "debug"]).optional().describe("Filter by minimum log level"),
    },
    async (args) => {
      await ensureInitialized();
      const logger = indexer.getLogger();

      if (!logger.isEnabled()) {
        return { content: [{ type: "text", text: "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true\n  }\n}\n```" }] };
      }

      let logs;
      if (args.category) {
        logs = logger.getLogsByCategory(args.category, args.limit);
      } else if (args.level) {
        logs = logger.getLogsByLevel(args.level as LogLevel, args.limit);
      } else {
        logs = logger.getLogs(args.limit);
      }

      if (logs.length === 0) {
        return { content: [{ type: "text", text: "No logs recorded yet. Logs are captured during indexing and search operations." }] };
      }

      const text = logs.map(l => {
        const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : "";
        return `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${dataStr}`;
      }).join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "find_similar",
    "Find code similar to a given snippet. Use for duplicate detection, pattern discovery, or refactoring prep.",
    {
      code: z.string().describe("The code snippet to find similar code for"),
      limit: z.number().optional().default(10).describe("Maximum number of results to return"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: z.enum(CHUNK_TYPE_ENUM).optional().describe("Filter by code chunk type"),
      excludeFile: z.string().optional().describe("Exclude results from this file path"),
    },
    async (args) => {
      await ensureInitialized();
      const results = await indexer.findSimilar(args.code, args.limit ?? 10, {
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        excludeFile: args.excludeFile,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No similar code found. Try a different snippet or run index_codebase first." }] };
      }

      const formatted = results.map((r, idx) => {
        const header = r.name
          ? `[${idx + 1}] ${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}-${r.endLine}`
          : `[${idx + 1}] ${r.chunkType} in ${r.filePath}:${r.startLine}-${r.endLine}`;
        return `${header} (similarity: ${(r.score * 100).toFixed(1)}%)\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
      });

      return { content: [{ type: "text", text: `Found ${results.length} similar code blocks:\n\n${formatted.join("\n\n")}` }] };
    },
  );

  // --- Prompts ---

  server.prompt(
    "search",
    "Search codebase by meaning using semantic search",
    { query: z.string().describe("What to search for in the codebase") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Search the codebase for: "${args.query}"\n\nUse the codebase_search tool with this query. If you need just locations first, use codebase_peek instead to save tokens.`,
        },
      }],
    }),
  );

  server.prompt(
    "find",
    "Find code using hybrid approach (semantic + grep)",
    { query: z.string().describe("What to find in the codebase") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Find code related to: "${args.query}"\n\nUse a hybrid approach:\n1. First use codebase_peek to find semantic matches by meaning\n2. Then use grep for exact identifier matches\n3. Combine results for comprehensive coverage`,
        },
      }],
    }),
  );

  server.prompt(
    "index",
    "Index the codebase for semantic search",
    { options: z.string().optional().describe("Options: 'force' to rebuild, 'estimate' to check costs") },
    (args) => {
      const opts = args.options?.toLowerCase() ?? "";
      let instruction = "Use the index_codebase tool to index the codebase for semantic search.";
      if (opts.includes("force")) {
        instruction = "Use the index_codebase tool with force=true to rebuild the entire index from scratch.";
      } else if (opts.includes("estimate")) {
        instruction = "Use the index_codebase tool with estimateOnly=true to check the cost estimate before indexing.";
      }
      return {
        messages: [{
          role: "user",
          content: { type: "text", text: instruction },
        }],
      };
    },
  );

  server.prompt(
    "status",
    "Check if the codebase is indexed and ready",
    {},
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Use the index_status tool to check if the codebase index is ready and show its current state.",
        },
      }],
    }),
  );

  return server;
}
