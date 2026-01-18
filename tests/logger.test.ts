import { describe, it, expect, beforeEach } from "vitest";
import { Logger } from "../src/utils/logger.js";
import type { DebugConfig } from "../src/config/schema.js";

describe("Logger", () => {
  describe("when disabled", () => {
    it("should not log when disabled", () => {
      const config: DebugConfig = {
        enabled: false,
        logLevel: "info",
        logSearch: true,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: false,
      };
      const logger = new Logger(config);
      
      logger.info("test message");
      logger.search("info", "search query");
      
      expect(logger.getLogs()).toHaveLength(0);
      expect(logger.isEnabled()).toBe(false);
    });
  });

  describe("when enabled", () => {
    let logger: Logger;

    beforeEach(() => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "debug",
        logSearch: true,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: true,
      };
      logger = new Logger(config);
    });

    it("should log messages when enabled", () => {
      logger.info("test message");
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe("test message");
      expect(logs[0].level).toBe("info");
      expect(logs[0].category).toBe("general");
    });

    it("should log search operations", () => {
      logger.search("info", "Searching for: authentication");
      
      const logs = logger.getLogsByCategory("search");
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe("Searching for: authentication");
    });

    it("should log embedding operations", () => {
      logger.embedding("info", "Embedding 100 chunks");
      
      const logs = logger.getLogsByCategory("embedding");
      expect(logs).toHaveLength(1);
    });

    it("should log cache operations", () => {
      logger.cache("info", "Cache hit for hash xyz");
      
      const logs = logger.getLogsByCategory("cache");
      expect(logs).toHaveLength(1);
    });

    it("should log gc operations", () => {
      logger.gc("info", "Garbage collection started");
      
      const logs = logger.getLogsByCategory("gc");
      expect(logs).toHaveLength(1);
    });

    it("should log branch operations", () => {
      logger.branch("info", "Detected branch: feature/test");
      
      const logs = logger.getLogsByCategory("branch");
      expect(logs).toHaveLength(1);
    });

    it("should respect log level filtering", () => {
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");
      
      const allLogs = logger.getLogs();
      expect(allLogs).toHaveLength(4);
      
      const warnLogs = logger.getLogsByLevel("warn");
      expect(warnLogs).toHaveLength(1);
      expect(warnLogs[0].level).toBe("warn");
    });

    it("should limit log entries", () => {
      for (let i = 0; i < 10; i++) {
        logger.info(`message ${i}`);
      }
      
      const limited = logger.getLogs(5);
      expect(limited).toHaveLength(5);
    });
  });

  describe("metrics", () => {
    let logger: Logger;

    beforeEach(() => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "debug",
        logSearch: true,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: true,
      };
      logger = new Logger(config);
    });

    it("should track cache hits and misses", () => {
      logger.recordCacheHit();
      logger.recordCacheHit();
      logger.recordCacheMiss();
      
      const metrics = logger.getMetrics();
      expect(metrics.cacheHits).toBe(2);
      expect(metrics.cacheMisses).toBe(1);
    });

    it("should track embedding API calls", () => {
      logger.recordEmbeddingApiCall(100);
      logger.recordEmbeddingApiCall(50);
      
      const metrics = logger.getMetrics();
      expect(metrics.embeddingApiCalls).toBe(2);
      expect(metrics.embeddingTokensUsed).toBe(150);
    });

    it("should track search timing", () => {
      logger.recordSearch(250);
      
      const metrics = logger.getMetrics();
      expect(metrics.searchCount).toBe(1);
      expect(metrics.searchTotalMs).toBe(250);
    });

    it("should track search timing with breakdown", () => {
      logger.recordSearch(250, { embeddingMs: 100, vectorMs: 80, keywordMs: 50, fusionMs: 20 });
      
      const metrics = logger.getMetrics();
      expect(metrics.searchCount).toBe(1);
      expect(metrics.embeddingCallMs).toBe(100);
      expect(metrics.vectorSearchMs).toBe(80);
      expect(metrics.keywordSearchMs).toBe(50);
      expect(metrics.fusionMs).toBe(20);
    });

    it("should track indexing stats", () => {
      logger.recordIndexingStart();
      logger.recordFilesScanned(10);
      logger.recordFilesParsed(8);
      logger.recordChunksProcessed(100);
      logger.recordChunksEmbedded(50);
      logger.recordChunksFromCache(50);
      logger.recordIndexingEnd();
      
      const metrics = logger.getMetrics();
      expect(metrics.filesScanned).toBe(10);
      expect(metrics.filesParsed).toBe(8);
      expect(metrics.chunksProcessed).toBe(100);
      expect(metrics.chunksEmbedded).toBe(50);
      expect(metrics.chunksFromCache).toBe(50);
    });

    it("should track GC stats", () => {
      logger.recordGc(5, 10, 3);
      
      const metrics = logger.getMetrics();
      expect(metrics.gcRuns).toBe(1);
      expect(metrics.gcOrphansRemoved).toBe(5);
      expect(metrics.gcChunksRemoved).toBe(10);
      expect(metrics.gcEmbeddingsRemoved).toBe(3);
    });

    it("should format metrics as readable string", () => {
      logger.recordCacheHit();
      logger.recordCacheHit();
      logger.recordCacheMiss();
      logger.recordFilesScanned(5);
      logger.recordFilesParsed(5);
      logger.recordChunksEmbedded(50);
      
      const formatted = logger.formatMetrics();
      expect(formatted).toContain("Hits: 2");
      expect(formatted).toContain("Misses: 1");
      expect(formatted).toContain("Files scanned: 5");
    });

    it("should not collect metrics when disabled", () => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "info",
        logSearch: true,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: false,
      };
      const noMetricsLogger = new Logger(config);
      
      noMetricsLogger.recordCacheHit();
      
      expect(noMetricsLogger.isMetricsEnabled()).toBe(false);
      expect(noMetricsLogger.getMetrics().cacheHits).toBe(0);
    });

    it("should reset metrics", () => {
      logger.recordCacheHit();
      logger.recordCacheHit();
      
      expect(logger.getMetrics().cacheHits).toBe(2);
      
      logger.resetMetrics();
      
      expect(logger.getMetrics().cacheHits).toBe(0);
    });
  });

  describe("category filtering", () => {
    it("should not log search when logSearch is false", () => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "debug",
        logSearch: false,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: false,
      };
      const logger = new Logger(config);
      
      logger.search("info", "should not appear");
      logger.embedding("info", "should appear");
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].category).toBe("embedding");
    });

    it("should not log embedding when logEmbedding is false", () => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "debug",
        logSearch: true,
        logEmbedding: false,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: false,
      };
      const logger = new Logger(config);
      
      logger.embedding("info", "should not appear");
      logger.search("info", "should appear");
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].category).toBe("search");
    });
  });

  describe("formatRecentLogs", () => {
    it("should format logs correctly", () => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "debug",
        logSearch: true,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: false,
      };
      const logger = new Logger(config);
      
      logger.info("test message");
      logger.search("debug", "search query", { query: "test" });
      
      const formatted = logger.formatRecentLogs(10);
      expect(formatted).toContain("[INFO]");
      expect(formatted).toContain("[general]");
      expect(formatted).toContain("test message");
      expect(formatted).toContain("[DEBUG]");
      expect(formatted).toContain("[search]");
      expect(formatted).toContain("search query");
    });

    it("should return message when no logs", () => {
      const config: DebugConfig = {
        enabled: true,
        logLevel: "debug",
        logSearch: true,
        logEmbedding: true,
        logCache: true,
        logGc: true,
        logBranch: true,
        metrics: false,
      };
      const logger = new Logger(config);
      
      expect(logger.formatRecentLogs()).toBe("No logs recorded.");
    });
  });
});
