import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { parseConfig, type ParsedCodebaseIndexConfig } from "../config/schema.js";
import { Indexer } from "../indexer/index.js";
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
import {
  findKnowledgeBasePathIndex,
  hasMatchingKnowledgeBasePath,
  resolveKnowledgeBasePath,
} from "./knowledge-base-paths.js";
import { existsSync, realpathSync, statSync } from "fs";
import * as path from "path";
import { loadProjectConfigLayer, materializeLocalProjectConfig } from "../config/merger.js";
import { resolveWorktreeMainRepoRoot } from "../git/index.js";
import { getConfigPath, loadEditableConfig, loadRuntimeConfig, saveConfig } from "./config-state.js";
import * as os from "os";

function ensureStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

const z = tool.schema;

const indexerMap = new Map<string, Indexer>();
let defaultProjectRoot: string = "";

export function initializeTools(projectRoot: string, config: ParsedCodebaseIndexConfig): void {
  defaultProjectRoot = projectRoot;
  const indexer = new Indexer(projectRoot, config);
  indexerMap.set(projectRoot, indexer);
}

export function getSharedIndexer(): Indexer {
  return getIndexerForProject(defaultProjectRoot);
}

function refreshIndexerForDirectory(projectRoot: string): void {
  if (!projectRoot) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }
  const indexer = new Indexer(projectRoot, parseConfig(loadRuntimeConfig(projectRoot)));
  indexerMap.set(projectRoot, indexer);
}

function shouldForceLocalizeProjectIndex(projectRoot: string): boolean {
  const currentConfig = parseConfig(loadRuntimeConfig(projectRoot));
  if (currentConfig.scope !== "project") {
    return false;
  }

  const localIndexPath = path.join(projectRoot, ".opencode", "index");
  const mainRepoRoot = resolveWorktreeMainRepoRoot(projectRoot);
  if (!mainRepoRoot) {
    return false;
  }

  const inheritedIndexPath = path.join(mainRepoRoot, ".opencode", "index");
  return !existsSync(localIndexPath) && existsSync(inheritedIndexPath);
}

export function getIndexerForProject(directory: string): Indexer {
  const projectRoot = directory || defaultProjectRoot;
  if (!projectRoot) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }

  let indexer = indexerMap.get(projectRoot);
  if (!indexer) {
    const config = parseConfig(loadRuntimeConfig(projectRoot));
    indexer = new Indexer(projectRoot, config);
    indexerMap.set(projectRoot, indexer);
  }
  return indexer;
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
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
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
    const projectRoot = context?.worktree || defaultProjectRoot;
    let indexer = getIndexerForProject(projectRoot);

    if (args.estimateOnly) {
      const estimate = await indexer.estimateCost();
      return formatCostEstimate(estimate);
    }

    if (args.force) {
      if (shouldForceLocalizeProjectIndex(projectRoot)) {
        materializeLocalProjectConfig(projectRoot, loadProjectConfigLayer(projectRoot));
        refreshIndexerForDirectory(projectRoot);
        indexer = getIndexerForProject(projectRoot);
      }
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
  async execute(_args, context) {
    const indexer = getIndexerForProject(context?.worktree);
    const status = await indexer.getStatus();
    return formatStatus(status);
  },
});

export const index_health_check: ToolDefinition = tool({
  description:
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
  args: {},
  async execute(_args, context) {
    const indexer = getIndexerForProject(context?.worktree);
    const result = await indexer.healthCheck();

    return formatHealthCheck(result);
  },
});

export const index_metrics: ToolDefinition = tool({
  description:
    "Get metrics and performance statistics for the codebase index. Shows indexing stats, search timings, cache hit rates, and API usage. Requires debug.enabled=true and debug.metrics=true in config.",
  args: {},
  async execute(_args, context) {
    const indexer = getIndexerForProject(context?.worktree);
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
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
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
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
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
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
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
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
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
    "Query the call graph to find callers or callees of a function/method. Use to understand code flow and dependencies between functions."
    + " Supports relationship types: Call, MethodCall, Constructor, Import, Inherits, Implements.",
  args: {
    name: z.string().describe("Function or method name to query"),
    direction: z.enum(["callers", "callees"]).default("callers").describe("Direction: 'callers' finds who calls this function, 'callees' finds what this function calls"),
    symbolId: z.string().optional().describe("Symbol ID (required for 'callees' direction, returned by previous call_graph queries)"),
    relationshipType: z.enum(["Call", "MethodCall", "Constructor", "Import", "Inherits", "Implements"]).optional().describe("Filter by relationship type. Omit to show all."),
  },
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
    if (args.direction === "callees") {
      if (!args.symbolId) {
        return "Error: 'symbolId' is required when direction is 'callees'. First use direction='callers' to find the symbol ID.";
      }
      let callees = await indexer.getCallees(args.symbolId, args.relationshipType);
      if (callees.length === 0) {
        return `No callees found for symbol ${args.symbolId}${args.relationshipType ? ` with type ${args.relationshipType}` : ""}. The function may not call any other tracked functions.`;
      }
      const formatted = callees.map((e, i) =>
        `[${i + 1}] \u2192 ${e.targetName} (${e.callType}) at line ${e.line}${e.isResolved ? ` [resolved: ${e.toSymbolId}]` : " [unresolved]"}`
      );
      return formatted.join("\n");
    }
    let callers = await indexer.getCallers(args.name, args.relationshipType);
    if (callers.length === 0) {
      return `No callers found for "${args.name}"${args.relationshipType ? ` with type ${args.relationshipType}` : ""}. It may not be called by any tracked function, or the index needs updating.`;
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
  async execute(args, context) {
    const projectRoot = context?.worktree || defaultProjectRoot;
    const inputPath = args.path.trim();

    const normalizedPath = path.resolve(
      path.isAbsolute(inputPath)
        ? inputPath
        : resolveKnowledgeBasePath(inputPath, projectRoot)
    );

    if (!existsSync(normalizedPath)) {
      return `Error: Directory does not exist: ${normalizedPath}`;
    }

    // Resolve symlinks to get the real path for security checks only
    let realPath: string;
    try {
      realPath = realpathSync(normalizedPath);
    } catch {
      return `Error: Cannot resolve path: ${normalizedPath}`;
    }

    // Security: block sensitive system directories (check against real path to prevent symlink bypass)
    const blockedPrefixes = [
      "/etc",
      "/proc",
      "/sys",
      "/dev",
      "/boot",
      "/root",
      "/var/run",
      "/var/log",
    ];
    const homeDir = os.homedir();
    const sensitiveDotDirs = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".docker", ".kube"];

    for (const prefix of blockedPrefixes) {
      if (realPath === prefix || realPath.startsWith(prefix + "/")) {
        return `Error: Adding system directory as knowledge base is not allowed: ${normalizedPath}`;
      }
    }

    for (const dotDir of sensitiveDotDirs) {
      const sensitiveDir = path.join(homeDir, dotDir);
      if (realPath === sensitiveDir || realPath.startsWith(sensitiveDir + "/")) {
        return `Error: Adding sensitive directory as knowledge base is not allowed: ${normalizedPath}`;
      }
    }

    try {
      const stat = statSync(normalizedPath);
      if (!stat.isDirectory()) {
        return `Error: Path is not a directory: ${normalizedPath}`;
      }
    } catch (error) {
      return `Error: Cannot access directory: ${normalizedPath} - ${error instanceof Error ? error.message : String(error)}`;
    }

    const config = loadEditableConfig(projectRoot);
    const knowledgeBases: string[] = ensureStringArray(config.knowledgeBases);

    const alreadyExists = hasMatchingKnowledgeBasePath(knowledgeBases, normalizedPath, projectRoot);

    if (alreadyExists) {
      return `Knowledge base already configured: ${normalizedPath}`;
    }

    knowledgeBases.push(normalizedPath);
    config.knowledgeBases = knowledgeBases;
    saveConfig(projectRoot, config);
    refreshIndexerForDirectory(projectRoot);

    let result = `${normalizedPath}\n`;
    result += `Total knowledge bases: ${knowledgeBases.length}\n`;
    result += `Config saved to: ${getConfigPath(projectRoot)}\n`;
    result += `\nRun /index to rebuild the index with the new knowledge base.`;

    return result;
  },
});

export const list_knowledge_bases: ToolDefinition = tool({
  description:
    "List all configured knowledge base folders that are indexed alongside the main project.",
  args: {},
  async execute(_args, context) {
    const projectRoot = context?.worktree || defaultProjectRoot;
    const config = loadRuntimeConfig(projectRoot);
    const knowledgeBases: string[] = ensureStringArray(config.knowledgeBases);

    if (knowledgeBases.length === 0) {
      return "No knowledge bases configured. Use add_knowledge_base to add folders.";
    }

    let result = `Knowledge Bases (${knowledgeBases.length}):\n\n`;

    for (let i = 0; i < knowledgeBases.length; i++) {
      const kb = knowledgeBases[i];
      const resolvedPath = resolveKnowledgeBasePath(kb, projectRoot);
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

    result += `Config file: ${getConfigPath(projectRoot)}`;
    return result;
  },
});

export const remove_knowledge_base: ToolDefinition = tool({
  description:
    "Remove a knowledge base folder from the semantic search index.",
  args: {
    path: z.string().describe("Path of the knowledge base to remove (must match the configured path exactly)"),
  },
  async execute(args, context) {
    const projectRoot = context?.worktree || defaultProjectRoot;
    const inputPath = args.path.trim();

    const config = loadEditableConfig(projectRoot);
    const knowledgeBases: string[] = ensureStringArray(config.knowledgeBases);

    if (knowledgeBases.length === 0) {
      return "No knowledge bases configured.";
    }

    const index = findKnowledgeBasePathIndex(knowledgeBases, inputPath, projectRoot);

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
    saveConfig(projectRoot, config);
    refreshIndexerForDirectory(projectRoot);

    let result = `Removed: ${removed}\n\n`;
    result += `Remaining knowledge bases: ${knowledgeBases.length}\n`;
    result += `Config saved to: ${getConfigPath(projectRoot)}\n`;
    result += `\nRun /index to rebuild the index without the removed knowledge base.`;

    return result;
  },
});
