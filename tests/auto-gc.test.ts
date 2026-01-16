import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../src/native/index.js";
import { parseConfig } from "../src/config/schema.js";

describe("Auto-GC", () => {
  describe("config parsing", () => {
    it("should use default GC values when not specified", () => {
      const config = parseConfig({});

      expect(config.indexing.autoGc).toBe(true);
      expect(config.indexing.gcIntervalDays).toBe(7);
      expect(config.indexing.gcOrphanThreshold).toBe(100);
    });

    it("should parse custom GC values", () => {
      const config = parseConfig({
        indexing: {
          autoGc: false,
          gcIntervalDays: 14,
          gcOrphanThreshold: 50,
        },
      });

      expect(config.indexing.autoGc).toBe(false);
      expect(config.indexing.gcIntervalDays).toBe(14);
      expect(config.indexing.gcOrphanThreshold).toBe(50);
    });

    it("should enforce minimum gcIntervalDays of 1", () => {
      const config = parseConfig({
        indexing: {
          gcIntervalDays: 0,
        },
      });

      expect(config.indexing.gcIntervalDays).toBe(1);
    });

    it("should enforce minimum gcIntervalDays of 1 for negative values", () => {
      const config = parseConfig({
        indexing: {
          gcIntervalDays: -5,
        },
      });

      expect(config.indexing.gcIntervalDays).toBe(1);
    });

    it("should enforce minimum gcOrphanThreshold of 0", () => {
      const config = parseConfig({
        indexing: {
          gcOrphanThreshold: -10,
        },
      });

      expect(config.indexing.gcOrphanThreshold).toBe(0);
    });

    it("should allow gcOrphanThreshold of 0", () => {
      const config = parseConfig({
        indexing: {
          gcOrphanThreshold: 0,
        },
      });

      expect(config.indexing.gcOrphanThreshold).toBe(0);
    });
  });

  describe("GC timestamp tracking", () => {
    let tempDir: string;
    let db: Database;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
      db = new Database(path.join(tempDir, "test.db"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should return null for lastGcTimestamp when never set", () => {
      expect(db.getMetadata("lastGcTimestamp")).toBeNull();
    });

    it("should store and retrieve lastGcTimestamp", () => {
      const timestamp = Date.now().toString();
      db.setMetadata("lastGcTimestamp", timestamp);

      expect(db.getMetadata("lastGcTimestamp")).toBe(timestamp);
    });

    it("should update lastGcTimestamp on subsequent sets", () => {
      const timestamp1 = "1000000000000";
      const timestamp2 = "2000000000000";

      db.setMetadata("lastGcTimestamp", timestamp1);
      db.setMetadata("lastGcTimestamp", timestamp2);

      expect(db.getMetadata("lastGcTimestamp")).toBe(timestamp2);
    });
  });

  describe("GC interval logic", () => {
    it("should trigger GC when lastGcTimestamp is null", () => {
      const lastGcTimestamp: string | null = null;
      const gcIntervalDays = 7;
      const intervalMs = gcIntervalDays * 24 * 60 * 60 * 1000;
      const now = Date.now();

      let shouldRunGc = false;
      if (!lastGcTimestamp) {
        shouldRunGc = true;
      } else {
        const lastGcTime = parseInt(lastGcTimestamp, 10);
        if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
          shouldRunGc = true;
        }
      }

      expect(shouldRunGc).toBe(true);
    });

    it("should trigger GC when interval has elapsed", () => {
      const gcIntervalDays = 7;
      const intervalMs = gcIntervalDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      const lastGcTimestamp = eightDaysAgo.toString();

      let shouldRunGc = false;
      if (!lastGcTimestamp) {
        shouldRunGc = true;
      } else {
        const lastGcTime = parseInt(lastGcTimestamp, 10);
        if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
          shouldRunGc = true;
        }
      }

      expect(shouldRunGc).toBe(true);
    });

    it("should not trigger GC when interval has not elapsed", () => {
      const gcIntervalDays = 7;
      const intervalMs = gcIntervalDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
      const lastGcTimestamp = threeDaysAgo.toString();

      let shouldRunGc = false;
      if (!lastGcTimestamp) {
        shouldRunGc = true;
      } else {
        const lastGcTime = parseInt(lastGcTimestamp, 10);
        if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
          shouldRunGc = true;
        }
      }

      expect(shouldRunGc).toBe(false);
    });

    it("should handle invalid timestamp gracefully", () => {
      const gcIntervalDays = 7;
      const intervalMs = gcIntervalDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const lastGcTimestamp = "invalid_timestamp";

      let shouldRunGc = false;
      if (!lastGcTimestamp) {
        shouldRunGc = true;
      } else {
        const lastGcTime = parseInt(lastGcTimestamp, 10);
        if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
          shouldRunGc = true;
        }
      }

      expect(shouldRunGc).toBe(false);
    });
  });

  describe("orphan threshold logic", () => {
    let tempDir: string;
    let db: Database;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-orphan-test-"));
      db = new Database(path.join(tempDir, "test.db"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should calculate orphan count from stats", () => {
      const embedding = Buffer.from(new Float32Array([1.0, 2.0]).buffer);
      db.upsertEmbedding("hash1", embedding, "text1", "model");
      db.upsertEmbedding("hash2", embedding, "text2", "model");
      db.upsertEmbedding("hash3", embedding, "text3", "model");

      db.upsertChunk({
        chunkId: "chunk1",
        contentHash: "hash1",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("main", ["chunk1"]);

      const stats = db.getStats();
      expect(stats).not.toBeNull();

      const orphanCount = stats!.embeddingCount - stats!.chunkCount;
      expect(orphanCount).toBe(2);
    });

    it("should trigger GC when orphan count exceeds threshold", () => {
      const gcOrphanThreshold = 1;

      const embedding = Buffer.from(new Float32Array([1.0, 2.0]).buffer);
      db.upsertEmbedding("hash1", embedding, "text1", "model");
      db.upsertEmbedding("hash2", embedding, "text2", "model");
      db.upsertEmbedding("hash3", embedding, "text3", "model");

      db.upsertChunk({
        chunkId: "chunk1",
        contentHash: "hash1",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("main", ["chunk1"]);

      const stats = db.getStats();
      const orphanCount = stats!.embeddingCount - stats!.chunkCount;

      const shouldRunGc = orphanCount > gcOrphanThreshold;
      expect(shouldRunGc).toBe(true);

      if (shouldRunGc) {
        const gcCount = db.gcOrphanEmbeddings();
        expect(gcCount).toBe(2);
      }
    });

    it("should not trigger GC when orphan count is below threshold", () => {
      const gcOrphanThreshold = 100;

      const embedding = Buffer.from(new Float32Array([1.0, 2.0]).buffer);
      db.upsertEmbedding("hash1", embedding, "text1", "model");

      db.upsertChunk({
        chunkId: "chunk1",
        contentHash: "hash1",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("main", ["chunk1"]);

      const stats = db.getStats();
      const orphanCount = stats!.embeddingCount - stats!.chunkCount;

      const shouldRunGc = orphanCount > gcOrphanThreshold;
      expect(shouldRunGc).toBe(false);
    });
  });
});
