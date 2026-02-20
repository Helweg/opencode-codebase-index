import { describe, it, expect } from "vitest";
import {
  formatIndexStats,
  formatStatus,
  formatProgressTitle,
  calculatePercentage,
  formatCodebasePeek,
  formatHealthCheck,
  formatLogs,
  formatSearchResults,
} from "../src/tools/utils.js";
import type { IndexStats, IndexProgress, SearchResult, HealthCheckResult, StatusResult } from "../src/indexer/index.js";
import type { LogEntry } from "../src/utils/logger.js";

function createBaseStats(overrides: Partial<IndexStats> = {}): IndexStats {
  return {
    totalFiles: 0,
    totalChunks: 0,
    indexedChunks: 0,
    failedChunks: 0,
    tokensUsed: 0,
    durationMs: 0,
    existingChunks: 0,
    removedChunks: 0,
    skippedFiles: [],
    parseFailures: [],
    ...overrides,
  };
}

describe("tools utils", () => {
  describe("formatIndexStats", () => {
    it("should show up-to-date message when nothing changed", () => {
      const stats = createBaseStats({ totalFiles: 50, existingChunks: 200 });
      const result = formatIndexStats(stats);

      expect(result).toContain("50 files processed");
      expect(result).toContain("200 code chunks already up to date");
    });

    it("should show removal message when only chunks removed", () => {
      const stats = createBaseStats({ totalFiles: 10, removedChunks: 5, existingChunks: 15 });
      const result = formatIndexStats(stats);

      expect(result).toContain("removed 5 stale chunks");
      expect(result).toContain("15 chunks remain");
    });

    it("should show new chunks embedded", () => {
      const stats = createBaseStats({
        totalFiles: 20,
        indexedChunks: 30,
        tokensUsed: 5000,
        durationMs: 2500,
      });
      const result = formatIndexStats(stats);

      expect(result).toContain("30 new chunks embedded");
      expect(result).toContain("5,000");
      expect(result).toContain("2.5s");
    });

    it("should show existing chunks skipped alongside new chunks", () => {
      const stats = createBaseStats({ totalFiles: 20, indexedChunks: 10, existingChunks: 40, tokensUsed: 1000, durationMs: 1000 });
      const result = formatIndexStats(stats);

      expect(result).toContain("10 new chunks embedded");
      expect(result).toContain("40 unchanged chunks skipped");
    });

    it("should show removed chunks when new chunks were also embedded", () => {
      const stats = createBaseStats({ totalFiles: 20, indexedChunks: 5, removedChunks: 3, tokensUsed: 500, durationMs: 500 });
      const result = formatIndexStats(stats);

      expect(result).toContain("Removed 3 stale chunks");
    });

    it("should show failed chunks", () => {
      const stats = createBaseStats({ totalFiles: 10, indexedChunks: 5, failedChunks: 2, tokensUsed: 500, durationMs: 500 });
      const result = formatIndexStats(stats);

      expect(result).toContain("Failed: 2 chunks");
    });

    it("should not include verbose details by default", () => {
      const stats = createBaseStats({
        totalFiles: 10,
        indexedChunks: 5,
        tokensUsed: 500,
        durationMs: 500,
        skippedFiles: [{ path: "big.js", reason: "too_large" }],
        parseFailures: ["empty.ts"],
      });
      const result = formatIndexStats(stats);

      expect(result).not.toContain("Skipped files");
      expect(result).not.toContain("big.js");
      expect(result).not.toContain("no extractable chunks");
    });

    it("should include verbose skipped file details", () => {
      const stats = createBaseStats({
        totalFiles: 10,
        indexedChunks: 5,
        tokensUsed: 500,
        durationMs: 500,
        skippedFiles: [
          { path: "big.js", reason: "too_large" },
          { path: "vendor.js", reason: "excluded" },
          { path: ".env", reason: "gitignore" },
        ],
      });
      const result = formatIndexStats(stats, true);

      expect(result).toContain("Skipped files: 3");
      expect(result).toContain("Too large (1)");
      expect(result).toContain("big.js");
      expect(result).toContain("Excluded (1)");
      expect(result).toContain("vendor.js");
      expect(result).toContain("Gitignored (1)");
      expect(result).toContain(".env");
    });

    it("should include verbose parse failures", () => {
      const stats = createBaseStats({
        totalFiles: 5,
        indexedChunks: 3,
        tokensUsed: 300,
        durationMs: 300,
        parseFailures: ["empty.ts", "broken.js"],
      });
      const result = formatIndexStats(stats, true);

      expect(result).toContain("no extractable chunks (2)");
      expect(result).toContain("empty.ts");
      expect(result).toContain("broken.js");
    });
  });

  describe("formatStatus", () => {
    it("should return not-indexed message when not indexed", () => {
      const status: StatusResult = {
        indexed: false,
        vectorCount: 0,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: null,
      };
      const result = formatStatus(status);

      expect(result).toContain("not indexed");
      expect(result).toContain("Run index_codebase");
    });

    it("should show basic status for indexed codebase on default branch", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 500,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: { compatible: true },
      };
      const result = formatStatus(status);

      expect(result).toContain("500");
      expect(result).toContain("openai");
      expect(result).toContain("text-embedding-3-small");
      expect(result).toContain("/tmp/index");
      expect(result).not.toContain("Current branch");
      expect(result).toContain("compatible");
    });

    it("should show branch info when not on default branch", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "github-copilot",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "feature-x",
        baseBranch: "main",
        compatibility: { compatible: true },
      };
      const result = formatStatus(status);

      expect(result).toContain("Current branch: feature-x");
      expect(result).toContain("Base branch: main");
    });

    it("should show compatibility warning when incompatible", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: {
          compatible: false,
          reason: "Dimension mismatch",
          storedMetadata: {
            indexVersion: "1",
            embeddingProvider: "google",
            embeddingModel: "text-embedding-004",
            embeddingDimensions: 768,
            createdAt: "2025-01-01",
            updatedAt: "2025-01-01",
          },
        },
      };
      const result = formatStatus(status);

      expect(result).toContain("COMPATIBILITY WARNING");
      expect(result).toContain("Dimension mismatch");
      expect(result).toContain("google/text-embedding-004");
      expect(result).toContain("768D");
    });

    it("should show no-compatibility-info message when compatibility is null", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: null,
      };
      const result = formatStatus(status);

      expect(result).toContain("No compatibility information found");
    });
  });

  describe("formatProgressTitle", () => {
    it("should format scanning phase", () => {
      expect(formatProgressTitle({ phase: "scanning", filesProcessed: 0, totalFiles: 0, chunksProcessed: 0, totalChunks: 0 })).toBe("Scanning files...");
    });

    it("should format parsing phase with counts", () => {
      expect(formatProgressTitle({ phase: "parsing", filesProcessed: 5, totalFiles: 20, chunksProcessed: 0, totalChunks: 0 })).toBe("Parsing: 5/20 files");
    });

    it("should format embedding phase with counts", () => {
      expect(formatProgressTitle({ phase: "embedding", filesProcessed: 20, totalFiles: 20, chunksProcessed: 30, totalChunks: 100 })).toBe("Embedding: 30/100 chunks");
    });

    it("should format storing phase", () => {
      expect(formatProgressTitle({ phase: "storing", filesProcessed: 20, totalFiles: 20, chunksProcessed: 100, totalChunks: 100 })).toBe("Storing index...");
    });

    it("should format complete phase", () => {
      expect(formatProgressTitle({ phase: "complete", filesProcessed: 20, totalFiles: 20, chunksProcessed: 100, totalChunks: 100 })).toBe("Indexing complete");
    });
  });

  describe("calculatePercentage", () => {
    const progress = (phase: IndexProgress["phase"], opts: Partial<IndexProgress> = {}): IndexProgress => ({
      phase,
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
      ...opts,
    });

    it("should return 0 for scanning", () => {
      expect(calculatePercentage(progress("scanning"))).toBe(0);
    });

    it("should return 100 for complete", () => {
      expect(calculatePercentage(progress("complete"))).toBe(100);
    });

    it("should return 5 for parsing with zero total files", () => {
      expect(calculatePercentage(progress("parsing", { totalFiles: 0 }))).toBe(5);
    });

    it("should calculate parsing percentage in 5-20 range", () => {
      const result = calculatePercentage(progress("parsing", { filesProcessed: 5, totalFiles: 10 }));
      expect(result).toBeGreaterThanOrEqual(5);
      expect(result).toBeLessThanOrEqual(20);
    });

    it("should return 20 at end of parsing", () => {
      expect(calculatePercentage(progress("parsing", { filesProcessed: 10, totalFiles: 10 }))).toBe(20);
    });

    it("should return 20 for embedding with zero total chunks", () => {
      expect(calculatePercentage(progress("embedding", { totalChunks: 0 }))).toBe(20);
    });

    it("should calculate embedding percentage in 20-90 range", () => {
      const result = calculatePercentage(progress("embedding", { chunksProcessed: 50, totalChunks: 100 }));
      expect(result).toBeGreaterThanOrEqual(20);
      expect(result).toBeLessThanOrEqual(90);
    });

    it("should return 90 at end of embedding", () => {
      expect(calculatePercentage(progress("embedding", { chunksProcessed: 100, totalChunks: 100 }))).toBe(90);
    });

    it("should return 95 for storing", () => {
      expect(calculatePercentage(progress("storing"))).toBe(95);
    });
  });

  describe("formatCodebasePeek", () => {
    it("should return empty message for no results", () => {
      const result = formatCodebasePeek([], "test query");

      expect(result).toContain("No matching code found");
    });

    it("should format results with names", () => {
      const results: SearchResult[] = [{
        filePath: "src/index.ts",
        startLine: 10,
        endLine: 20,
        content: "",
        score: 0.85,
        chunkType: "function",
        name: "initialize",
      }];
      const result = formatCodebasePeek(results, "init function");

      expect(result).toContain("1 locations");
      expect(result).toContain('"initialize"');
      expect(result).toContain("src/index.ts:10-20");
      expect(result).toContain("0.85");
      expect(result).toContain("function");
      expect(result).toContain("Use Read tool");
    });

    it("should format results without names as anonymous", () => {
      const results: SearchResult[] = [{
        filePath: "src/utils.ts",
        startLine: 1,
        endLine: 5,
        content: "",
        score: 0.70,
        chunkType: "other",
      }];
      const result = formatCodebasePeek(results, "utils");

      expect(result).toContain("(anonymous)");
    });

    it("should include query in output", () => {
      const results: SearchResult[] = [{
        filePath: "a.ts",
        startLine: 1,
        endLine: 2,
        content: "",
        score: 0.5,
        chunkType: "function",
        name: "foo",
      }];
      const result = formatCodebasePeek(results, "my search query");

      expect(result).toContain('"my search query"');
    });
  });

  describe("formatHealthCheck", () => {
    it("should return healthy message when nothing to clean", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
      });

      expect(result).toBe("Index is healthy. No stale entries found.");
    });

    it("should show removed stale entries", () => {
      const result = formatHealthCheck({
        removed: 5,
        filePaths: ["src/old.ts", "src/deleted.ts"],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
      });

      expect(result).toContain("Removed stale entries: 5");
      expect(result).toContain("src/old.ts");
      expect(result).toContain("src/deleted.ts");
    });

    it("should show orphan embeddings", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 10,
        gcOrphanChunks: 0,
      });

      expect(result).toContain("orphan embeddings: 10");
    });

    it("should show orphan chunks", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 3,
      });

      expect(result).toContain("orphan chunks: 3");
    });

    it("should show all fields when all have values", () => {
      const result = formatHealthCheck({
        removed: 2,
        filePaths: ["a.ts"],
        gcOrphanEmbeddings: 5,
        gcOrphanChunks: 3,
      });

      expect(result).toContain("Removed stale entries: 2");
      expect(result).toContain("orphan embeddings: 5");
      expect(result).toContain("orphan chunks: 3");
      expect(result).toContain("a.ts");
    });
  });

  describe("formatLogs", () => {
    it("should return empty message for no logs", () => {
      const result = formatLogs([]);

      expect(result).toContain("No logs recorded yet");
    });

    it("should format log entries with timestamp, level, category, and message", () => {
      const logs: LogEntry[] = [{
        timestamp: "2025-01-15T10:00:00Z",
        level: "info",
        category: "search",
        message: "Query completed",
      }];
      const result = formatLogs(logs);

      expect(result).toContain("[2025-01-15T10:00:00Z]");
      expect(result).toContain("[INFO]");
      expect(result).toContain("[search]");
      expect(result).toContain("Query completed");
    });

    it("should include data as JSON when present", () => {
      const logs: LogEntry[] = [{
        timestamp: "2025-01-15T10:00:00Z",
        level: "debug",
        category: "embedding",
        message: "Batch sent",
        data: { batchSize: 10, tokensUsed: 500 },
      }];
      const result = formatLogs(logs);

      expect(result).toContain("[DEBUG]");
      expect(result).toContain('"batchSize":10');
      expect(result).toContain('"tokensUsed":500');
    });

    it("should format multiple log entries on separate lines", () => {
      const logs: LogEntry[] = [
        { timestamp: "T1", level: "info", category: "search", message: "First" },
        { timestamp: "T2", level: "warn", category: "gc", message: "Second" },
      ];
      const result = formatLogs(logs);
      const lines = result.split("\n");

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("First");
      expect(lines[1]).toContain("Second");
    });
  });

  describe("formatSearchResults", () => {
    it("should format results with names", () => {
      const results: SearchResult[] = [{
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        content: "function validateToken() {\n  return true;\n}",
        score: 0.92,
        chunkType: "function",
        name: "validateToken",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain('[1] function "validateToken" in src/auth.ts:10-25');
      expect(result).toContain("92.0%");
      expect(result).toContain("```");
      expect(result).toContain("function validateToken()");
    });

    it("should format results without names", () => {
      const results: SearchResult[] = [{
        filePath: "src/config.ts",
        startLine: 1,
        endLine: 3,
        content: "const x = 1;",
        score: 0.50,
        chunkType: "other",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain("[1] other in src/config.ts:1-3");
      expect(result).not.toContain('"null"');
    });

    it("should truncate content longer than 30 lines", () => {
      const longContent = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const results: SearchResult[] = [{
        filePath: "src/big.ts",
        startLine: 1,
        endLine: 50,
        content: longContent,
        score: 0.80,
        chunkType: "function",
        name: "bigFunction",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain("line 1");
      expect(result).toContain("line 30");
      expect(result).not.toContain("line 31");
      expect(result).toContain("20 more lines");
    });

    it("should not truncate content with exactly 30 lines", () => {
      const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
      const results: SearchResult[] = [{
        filePath: "src/exact.ts",
        startLine: 1,
        endLine: 30,
        content,
        score: 0.75,
        chunkType: "function",
        name: "exactFunction",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain("line 30");
      expect(result).not.toContain("more lines");
    });

    it("should format multiple results with numbered indices", () => {
      const results: SearchResult[] = [
        { filePath: "a.ts", startLine: 1, endLine: 2, content: "a", score: 0.9, chunkType: "function", name: "first" },
        { filePath: "b.ts", startLine: 3, endLine: 4, content: "b", score: 0.8, chunkType: "class", name: "second" },
        { filePath: "c.ts", startLine: 5, endLine: 6, content: "c", score: 0.7, chunkType: "method", name: "third" },
      ];
      const result = formatSearchResults(results);

      expect(result).toContain("[1]");
      expect(result).toContain("[2]");
      expect(result).toContain("[3]");
      expect(result).toContain('"first"');
      expect(result).toContain('"second"');
      expect(result).toContain('"third"');
    });
  });
});
