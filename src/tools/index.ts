import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { Indexer } from "../indexer/index.js";
import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import { formatCostEstimate } from "../utils/cost.js";
import type { LogLevel } from "../config/schema.js";
import type { LogEntry } from "../utils/logger.js";
import {
  formatProgressTitle,
  formatIndexStats,
  formatStatus,
  calculatePercentage,
  formatCodebasePeek,
  formatDefinitionLookup,
  formatHealthCheck,
  formatLogs,
  formatSearchResults,
} from "./utils.js";
import { existsSync, writeFileSync, mkdirSync, statSync } from "fs";
import * as path from "path";
import { loadMergedConfig } from "../config/merger.js";

const z = tool.schema;

let sharedIndexer: Indexer | null = null;
let sharedProjectRoot: string = "";

export function initializeTools(projectRoot: string, config: ParsedCodebaseIndexConfig): void {
  sharedProjectRoot = projectRoot;
  sharedIndexer = new Indexer(projectRoot, config);
}

function getIndexer(): Indexer {
  if (!sharedIndexer) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }
  return sharedIndexer;
}

function getConfigPath(): string {
  return path.join(sharedProjectRoot, ".opencode", "codebase-index.json");
}

function loadConfig(): Record<string, unknown> {
  const rawConfig = loadMergedConfig(sharedProjectRoot);
  const config: Record<string, unknown> = {};
  
  if (rawConfig && typeof rawConfig === "object") {
    for (const key of Object.keys(rawConfig)) {
      config[key] = rawConfig[key as keyof typeof rawConfig];
    }
  }
  
  if (Array.isArray(config.knowledgeBases)) {
    config.knowledgeBases = (config.knowledgeBases as string[]).map(kb => {
      const resolved = path.isAbsolute(kb) ? kb : path.resolve(sharedProjectRoot, kb);
      return path.normalize(resolved);
    });
  }
  
  if (Array.isArray(config.additionalInclude)) {
    config.additionalInclude = (config.additionalInclude as string[]).map(pattern => {
      const resolved = path.isAbsolute(pattern) ? pattern : path.resolve(sharedProjectRoot, pattern);
      return path.normalize(resolved);
    });
  }
  
  return config;
}

function saveConfig(config: Record<string, unknown>): void {
  const configDir = path.join(sharedProjectRoot, ".opencode");
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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

    return formatCodebasePeek(results);
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

    let logs: LogEntry[];
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

    return formatSearchResults(results);
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

    return formatSearchResults(results, "score");
  },
});

export const implementation_lookup: ToolDefinition = tool({
  description:
    "Jump to symbol definition. Find WHERE something is defined. " +
    "Returns the authoritative source location(s) for a function, class, method, type, or variable. " +
    "Prefers real implementation files over tests, docs, examples, and fixtures. " +
    "Use when you need the definition site, not all usages.",
  args: {
    query: z.string().describe("Symbol name or natural language description (e.g., 'validateToken', 'where is the payment handler defined')"),
    limit: z.number().optional().default(5).describe("Maximum number of results"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils')"),
  },
  async execute(args) {
    const indexer = getIndexer();
    const results = await indexer.search(args.query, args.limit ?? 5, {
      fileType: args.fileType,
      directory: args.directory,
      definitionIntent: true,
    });
    return formatDefinitionLookup(results, args.query);
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
      return formatted.join("\n");
    }
    const callers = await indexer.getCallers(args.name);
    if (callers.length === 0) {
      return `No callers found for "${args.name}". It may not be called by any tracked function, or the index needs updating.`;
    }
    const formatted = callers.map((e, i) =>
      `[${i + 1}] \u2190 from ${e.fromSymbolName ?? "<unknown>"} in ${e.fromSymbolFilePath ?? "<unknown file>"} [${e.fromSymbolId}] (${e.callType}) at line ${e.line}${e.isResolved ? " [resolved]" : " [unresolved]"}`
    );
    return formatted.join("\n");
  },
});

export const add_knowledge_base: ToolDefinition = tool({
  description:
    "Add a folder as a knowledge base to the semantic search index. " +
    "The folder will be indexed alongside the main project code. " +
    "Supports absolute paths or relative paths (relative to the project root).",
  args: {
    path: z.string().describe("Path to the folder to add as a knowledge base (absolute or relative to project root)"),
  },
  async execute(args) {
    const inputPath = args.path.trim();

    // Resolve the path
    const resolvedPath = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(sharedProjectRoot, inputPath);

    // Validate the directory exists
    if (!existsSync(resolvedPath)) {
      return `Error: Directory does not exist: ${resolvedPath}`;
    }

    try {
      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return `Error: Path is not a directory: ${resolvedPath}`;
      }
    } catch (error) {
      return `Error: Cannot access directory: ${resolvedPath} - ${error instanceof Error ? error.message : String(error)}`;
    }

    // Load current config
    const config = loadConfig();
    const knowledgeBases: string[] = Array.isArray(config.knowledgeBases)
      ? config.knowledgeBases as string[]
      : [];

    // Check if already added (normalize paths for comparison)
    const normalizedPath = path.normalize(resolvedPath);
    const alreadyExists = knowledgeBases.some(
      kb => path.normalize(path.isAbsolute(kb) ? kb : path.resolve(sharedProjectRoot, kb)) === normalizedPath
    );

    if (alreadyExists) {
      return `Knowledge base already configured: ${resolvedPath}`;
    }

    // Add the knowledge base
    knowledgeBases.push(resolvedPath);
    config.knowledgeBases = knowledgeBases;
    saveConfig(config);

    let result = `${resolvedPath}\n`;
    result += `Total knowledge bases: ${knowledgeBases.length}\n`;
    result += `Config saved to: ${getConfigPath()}\n`;
    result += `\nRun /index to rebuild the index with the new knowledge base.`;

    return result;
  },
});

export const list_knowledge_bases: ToolDefinition = tool({
  description:
    "List all configured knowledge base folders that are indexed alongside the main project.",
  args: {},
  async execute() {
    const config = loadConfig();
    const knowledgeBases: string[] = Array.isArray(config.knowledgeBases)
      ? config.knowledgeBases as string[]
      : [];

    if (knowledgeBases.length === 0) {
      return "No knowledge bases configured. Use add_knowledge_base to add folders.";
    }

    let result = `Knowledge Bases (${knowledgeBases.length}):\n\n`;

    for (let i = 0; i < knowledgeBases.length; i++) {
      const kb = knowledgeBases[i];
      const resolvedPath = path.isAbsolute(kb) ? kb : path.resolve(sharedProjectRoot, kb);
      const exists = existsSync(resolvedPath);

      result += `[${i + 1}] ${kb}\n`;
      result += `    Resolved: ${resolvedPath}\n`;
      result += `    Status: ${exists ? "Exists" : "NOT FOUND"}\n`;
      if (exists) {
        try {
          const stat = statSync(resolvedPath);
          result += `    Type: ${stat.isDirectory() ? "Directory" : "File"}\n`;
        } catch { /* ignore */ }
      }
      result += "\n";
    }

    result += `Config file: ${getConfigPath()}`;
    return result;
  },
});

export const remove_knowledge_base: ToolDefinition = tool({
  description:
    "Remove a knowledge base folder from the semantic search index.",
  args: {
    path: z.string().describe("Path of the knowledge base to remove (must match the configured path exactly)"),
  },
  async execute(args) {
    const inputPath = args.path.trim();

    // Load current config
    const config = loadConfig();
    const knowledgeBases: string[] = Array.isArray(config.knowledgeBases)
      ? config.knowledgeBases as string[]
      : [];

    if (knowledgeBases.length === 0) {
      return "No knowledge bases configured.";
    }

    // Find and remove the knowledge base
    const normalizedInput = path.normalize(inputPath);
    const index = knowledgeBases.findIndex(
      kb => path.normalize(kb) === normalizedInput ||
           path.normalize(path.isAbsolute(kb) ? kb : path.resolve(sharedProjectRoot, kb)) === normalizedInput
    );

    if (index === -1) {
      let result = `Knowledge base not found: ${inputPath}\n\n`;
      result += `Currently configured:\n`;
      for (const kb of knowledgeBases) {
        result += `  - ${kb}\n`;
      }
      return result;
    }

    const removed = knowledgeBases.splice(index, 1)[0];
    config.knowledgeBases = knowledgeBases;
    saveConfig(config);

    let result = `Removed: ${removed}\n\n`;
    result += `Remaining knowledge bases: ${knowledgeBases.length}\n`;
    result += `Config saved to: ${getConfigPath()}\n`;
    result += `\nRun /index to rebuild the index without the removed knowledge base.`;

    return result;
  },
});
