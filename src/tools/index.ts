import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { Indexer, IndexStats } from "../indexer/index.js";
import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import { formatCostEstimate } from "../utils/cost.js";

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

export const codebase_search: ToolDefinition = tool({
  description:
    "Search codebase by MEANING, not keywords. Use when you don't know exact function/class names. Returns focused results (5-10 files). For known identifiers like 'validateToken' or 'UserService', use grep instead - it's faster and finds all occurrences. Best for: 'find authentication logic', 'code that handles payments', 'error middleware'.",
  args: {
    query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(["function", "class", "method", "interface", "type", "enum", "struct", "impl", "trait", "module", "other"]).optional().describe("Filter by code chunk type"),
    contextLines: z.number().optional().describe("Number of extra lines to include before/after each match (default: 0)"),
  },
  async execute(args) {
    const indexer = getIndexer();
    const results = await indexer.search(args.query, args.limit ?? 10, {
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
      contextLines: args.contextLines,
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
    force: z.boolean().optional().default(false).describe("Force reindex even if already indexed"),
    estimateOnly: z.boolean().optional().default(false).describe("Only show cost estimate without indexing"),
    verbose: z.boolean().optional().default(false).describe("Show detailed info about skipped files and parsing failures"),
  },
  async execute(args) {
    const indexer = getIndexer();

    if (args.estimateOnly) {
      const estimate = await indexer.estimateCost();
      return formatCostEstimate(estimate);
    }

    if (args.force) {
      await indexer.clearIndex();
    }

    const stats = await indexer.index();
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

    if (result.removed === 0 && result.gcOrphanEmbeddings === 0 && result.gcOrphanChunks === 0) {
      return "Index is healthy. No stale entries found.";
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

    return lines.join("\n");
  },
});

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
