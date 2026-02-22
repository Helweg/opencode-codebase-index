import { IndexStats, IndexProgress, SearchResult, HealthCheckResult, StatusResult } from "../indexer/index.js";
import type { LogEntry } from "../utils/logger.js";

const MAX_CONTENT_LINES = 30;

function truncateContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTENT_LINES) return content;
  return (
    lines.slice(0, MAX_CONTENT_LINES).join("\n") +
    `\n// ... (${lines.length - MAX_CONTENT_LINES} more lines)`
  );
}

export function formatIndexStats(stats: IndexStats, verbose: boolean = false): string {
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

export function formatStatus(status: StatusResult): string {
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

  if (status.compatibility && !status.compatibility.compatible) {
    lines.push("");
    lines.push(`COMPATIBILITY WARNING: ${status.compatibility.reason}`);
    if (status.compatibility.storedMetadata) {
      const stored = status.compatibility.storedMetadata;
      lines.push(`  Index was built with: ${stored.embeddingProvider}/${stored.embeddingModel} (${stored.embeddingDimensions}D)`);
      lines.push(`  Current config:       ${status.provider}/${status.model}`);
    }
  } else if (!status.compatibility) {
    lines.push(`  Compatibility: No compatibility information found. Maybe the index is not initialized yet, try running index_codebase.`);
  } else {
    lines.push(`  Compatibility: Index is compatible with the current provider and model.`);
  }

  return lines.join("\n");
}

export function formatProgressTitle(progress: IndexProgress): string {
  switch (progress.phase) {
    case "scanning":
      return "Scanning files...";
    case "parsing":
      return `Parsing: ${progress.filesProcessed}/${progress.totalFiles} files`;
    case "embedding":
      return `Embedding: ${progress.chunksProcessed}/${progress.totalChunks} chunks`;
    case "storing":
      return "Storing index...";
    case "complete":
      return "Indexing complete";
    default:
      return "Indexing...";
  }
}

export function calculatePercentage(progress: IndexProgress): number {
  if (progress.phase === "scanning") return 0;
  if (progress.phase === "complete") return 100;
  
  if (progress.phase === "parsing") {
    if (progress.totalFiles === 0) return 5;
    return Math.round(5 + (progress.filesProcessed / progress.totalFiles) * 15);
  }
  
  if (progress.phase === "embedding") {
    if (progress.totalChunks === 0) return 20;
    return Math.round(20 + (progress.chunksProcessed / progress.totalChunks) * 70);
  }
  
  if (progress.phase === "storing") return 95;
  
  return 0;
}

export function formatCodebasePeek(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return "No matching code found. Try a different query or run index_codebase first.";
  }

  const formatted = results.map((r, idx) => {
    const location = `${r.filePath}:${r.startLine}-${r.endLine}`;
    const name = r.name ? `"${r.name}"` : "(anonymous)";
    return `[${idx + 1}] ${r.chunkType} ${name} at ${location} (score: ${r.score.toFixed(2)})`;
  });

  return `Found ${results.length} locations for "${query}":\n\n${formatted.join("\n")}\n\nUse Read tool to examine specific files.`;
}

export function formatHealthCheck(result: HealthCheckResult): string {
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
}

export function formatLogs(logs: LogEntry[]): string {
  if (logs.length === 0) {
    return "No logs recorded yet. Logs are captured during indexing and search operations.";
  }

  return logs.map(l => {
    const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : "";
    return `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${dataStr}`;
  }).join("\n");
}

export type ScoreFormat = "score" | "similarity";

export function formatSearchResults(results: SearchResult[], scoreFormat: ScoreFormat = "similarity"): string {
  const formatted = results.map((r, idx) => {
    const header = r.name
      ? `[${idx + 1}] ${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}-${r.endLine}`
      : `[${idx + 1}] ${r.chunkType} in ${r.filePath}:${r.startLine}-${r.endLine}`;

    const scoreLabel = scoreFormat === "similarity"
      ? `(similarity: ${(r.score * 100).toFixed(1)}%)`
      : `(score: ${r.score.toFixed(2)})`;

    return `${header} ${scoreLabel}\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
  });

  return formatted.join("\n\n");
}
