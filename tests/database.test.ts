import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database, ChunkData } from "../src/native/index.js";

describe("Database", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-test-"));
    db = new Database(path.join(tempDir, "test.db"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("embeddings", () => {
    it("should check if embedding exists", () => {
      expect(db.embeddingExists("hash123")).toBe(false);
    });

    it("should upsert and retrieve embedding", () => {
      const embedding = Buffer.from(new Float32Array([1.0, 2.0, 3.0]).buffer);
      db.upsertEmbedding("hash123", embedding, "test chunk text", "test-model");

      expect(db.embeddingExists("hash123")).toBe(true);

      const retrieved = db.getEmbedding("hash123");
      expect(retrieved).not.toBeNull();
      
      const floats = new Float32Array(retrieved!.buffer, retrieved!.byteOffset, retrieved!.byteLength / 4);
      expect(floats[0]).toBeCloseTo(1.0);
      expect(floats[1]).toBeCloseTo(2.0);
      expect(floats[2]).toBeCloseTo(3.0);
    });

    it("should return null for non-existent embedding", () => {
      expect(db.getEmbedding("nonexistent")).toBeNull();
    });

    it("should get missing embeddings from a list", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("exists", embedding, "text", "model");

      const missing = db.getMissingEmbeddings(["exists", "missing1", "missing2"]);
      
      expect(missing).toContain("missing1");
      expect(missing).toContain("missing2");
      expect(missing).not.toContain("exists");
    });
  });

  describe("chunks", () => {
    const testChunk: ChunkData = {
      chunkId: "chunk_abc123",
      contentHash: "hash456",
      filePath: "/path/to/file.ts",
      startLine: 10,
      endLine: 20,
      nodeType: "function",
      name: "testFunction",
      language: "typescript",
    };

    it("should upsert and retrieve chunk", () => {
      db.upsertChunk(testChunk);

      const retrieved = db.getChunk("chunk_abc123");
      
      expect(retrieved).not.toBeNull();
      expect(retrieved!.chunkId).toBe("chunk_abc123");
      expect(retrieved!.contentHash).toBe("hash456");
      expect(retrieved!.filePath).toBe("/path/to/file.ts");
      expect(retrieved!.startLine).toBe(10);
      expect(retrieved!.endLine).toBe(20);
      expect(retrieved!.nodeType).toBe("function");
      expect(retrieved!.name).toBe("testFunction");
      expect(retrieved!.language).toBe("typescript");
    });

    it("should return null for non-existent chunk", () => {
      expect(db.getChunk("nonexistent")).toBeNull();
    });

    it("should get chunks by file path", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({
        ...testChunk,
        chunkId: "chunk_def456",
        startLine: 30,
        endLine: 40,
      });

      const chunks = db.getChunksByFile("/path/to/file.ts");
      
      expect(chunks.length).toBe(2);
    });

    it("should delete chunks by file path", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({
        ...testChunk,
        chunkId: "chunk_def456",
      });

      const deleted = db.deleteChunksByFile("/path/to/file.ts");
      
      expect(deleted).toBe(2);
      expect(db.getChunk("chunk_abc123")).toBeNull();
    });
  });

  describe("branch_chunks", () => {
    const testChunk: ChunkData = {
      chunkId: "chunk_abc123",
      contentHash: "hash456",
      filePath: "/path/to/file.ts",
      startLine: 10,
      endLine: 20,
      nodeType: "function",
      language: "typescript",
    };

    it("should add chunks to branch", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);

      const chunkIds = db.getBranchChunkIds("main");
      
      expect(chunkIds).toContain("chunk_abc123");
    });

    it("should check if chunk exists on branch", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);

      expect(db.chunkExistsOnBranch("main", "chunk_abc123")).toBe(true);
      expect(db.chunkExistsOnBranch("main", "nonexistent")).toBe(false);
      expect(db.chunkExistsOnBranch("other-branch", "chunk_abc123")).toBe(false);
    });

    it("should clear branch", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);
      
      const cleared = db.clearBranch("main");
      
      expect(cleared).toBe(1);
      expect(db.getBranchChunkIds("main").length).toBe(0);
    });

    it("should get all branches", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);
      db.addChunksToBranch("feature", ["chunk_abc123"]);

      const branches = db.getAllBranches();
      
      expect(branches).toContain("main");
      expect(branches).toContain("feature");
    });

    it("should compute branch delta", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({ ...testChunk, chunkId: "chunk_main_only" });
      db.upsertChunk({ ...testChunk, chunkId: "chunk_feature_only" });

      db.addChunksToBranch("main", ["chunk_abc123", "chunk_main_only"]);
      db.addChunksToBranch("feature", ["chunk_abc123", "chunk_feature_only"]);

      const delta = db.getBranchDelta("feature", "main");
      
      expect(delta.added).toContain("chunk_feature_only");
      expect(delta.removed).toContain("chunk_main_only");
      expect(delta.added).not.toContain("chunk_abc123");
      expect(delta.removed).not.toContain("chunk_abc123");
    });
  });

  describe("metadata", () => {
    it("should set and get metadata", () => {
      db.setMetadata("version", "1.0.0");
      
      expect(db.getMetadata("version")).toBe("1.0.0");
    });

    it("should return null for non-existent metadata", () => {
      expect(db.getMetadata("nonexistent")).toBeNull();
    });

    it("should delete metadata", () => {
      db.setMetadata("key", "value");
      
      const deleted = db.deleteMetadata("key");
      
      expect(deleted).toBe(true);
      expect(db.getMetadata("key")).toBeNull();
    });

    it("should update existing metadata", () => {
      db.setMetadata("key", "value1");
      db.setMetadata("key", "value2");
      
      expect(db.getMetadata("key")).toBe("value2");
    });
  });

  describe("garbage collection", () => {
    it("should gc orphan embeddings", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("orphan_hash", embedding, "text", "model");

      const gcCount = db.gcOrphanEmbeddings();
      
      expect(gcCount).toBe(1);
      expect(db.embeddingExists("orphan_hash")).toBe(false);
    });

    it("should not gc referenced embeddings", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("referenced_hash", embedding, "text", "model");
      db.upsertChunk({
        chunkId: "chunk1",
        contentHash: "referenced_hash",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });

      const gcCount = db.gcOrphanEmbeddings();
      
      expect(gcCount).toBe(0);
      expect(db.embeddingExists("referenced_hash")).toBe(true);
    });

    it("should gc orphan chunks", () => {
      db.upsertChunk({
        chunkId: "orphan_chunk",
        contentHash: "hash",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });

      const gcCount = db.gcOrphanChunks();
      
      expect(gcCount).toBe(1);
      expect(db.getChunk("orphan_chunk")).toBeNull();
    });

    it("should not gc chunks referenced by branches", () => {
      db.upsertChunk({
        chunkId: "referenced_chunk",
        contentHash: "hash",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("main", ["referenced_chunk"]);

      const gcCount = db.gcOrphanChunks();
      
      expect(gcCount).toBe(0);
      expect(db.getChunk("referenced_chunk")).not.toBeNull();
    });
  });

  describe("stats", () => {
    it("should return database stats", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("hash1", embedding, "text", "model");
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
      
      expect(stats.embeddingCount).toBe(1);
      expect(stats.chunkCount).toBe(1);
      expect(stats.branchChunkCount).toBe(1);
      expect(stats.branchCount).toBe(1);
    });
  });
});
