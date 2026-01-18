import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseFile,
  parseFiles,
  hashContent,
  hashFile,
  VectorStore,
  createEmbeddingText,
  createDynamicBatches,
  generateChunkId,
  estimateTokens,
  type CodeChunk,
} from "../src/native/index.js";

describe("native module", () => {
  describe("parseFile", () => {
    it("should parse TypeScript functions", () => {
      const content = `
export function validateEmail(email: string): boolean {
  return email.includes("@");
}

export async function fetchUser(id: number): Promise<User> {
  return await db.query(id);
}
`;
      const chunks = parseFile("test.ts", content);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.content.includes("validateEmail"))).toBe(true);
      expect(chunks.some((c) => c.content.includes("fetchUser"))).toBe(true);
    });

    it("should parse TypeScript classes", () => {
      const content = `
export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: number): Promise<User> {
    return this.db.find(id);
  }
}
`;
      const chunks = parseFile("service.ts", content);

      expect(chunks.some((c) => c.content.includes("class UserService"))).toBe(true);
    });

    it("should parse JavaScript files", () => {
      const content = `
function greet(name) {
  console.log("Hello, " + name);
}

const add = (a, b) => a + b;
`;
      const chunks = parseFile("util.js", content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty array for unparseable content", () => {
      const chunks = parseFile("data.txt", "just plain text");

      expect(chunks).toBeInstanceOf(Array);
    });
  });

  describe("parseFiles", () => {
    it("should parse multiple files in batch", () => {
      const files = [
        { path: "a.ts", content: "export function foo() {}" },
        { path: "b.ts", content: "export function bar() {}" },
      ];

      const results = parseFiles(files);

      expect(results.length).toBe(2);
      expect(results[0].path).toBe("a.ts");
      expect(results[1].path).toBe("b.ts");
    });
  });

  describe("hashContent", () => {
    it("should return consistent hash for same content", () => {
      const hash1 = hashContent("test content");
      const hash2 = hashContent("test content");

      expect(hash1).toBe(hash2);
    });

    it("should return different hash for different content", () => {
      const hash1 = hashContent("content A");
      const hash2 = hashContent("content B");

      expect(hash1).not.toBe(hash2);
    });

    it("should return non-empty string", () => {
      const hash = hashContent("test");

      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe("hashFile", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should hash file content", () => {
      const filePath = path.join(tempDir, "test.txt");
      fs.writeFileSync(filePath, "file content");

      const hash = hashFile(filePath);

      expect(hash.length).toBeGreaterThan(0);
    });

    it("should return same hash for identical files", () => {
      const file1 = path.join(tempDir, "a.txt");
      const file2 = path.join(tempDir, "b.txt");
      fs.writeFileSync(file1, "same content");
      fs.writeFileSync(file2, "same content");

      expect(hashFile(file1)).toBe(hashFile(file2));
    });
  });

  describe("VectorStore", () => {
    let tempDir: string;
    let store: VectorStore;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vector-test-"));
      store = new VectorStore(path.join(tempDir, "vectors"), 3);
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should add and retrieve vectors", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      expect(store.count()).toBe(1);
    });

    it("should search for similar vectors", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.add("chunk2", [0, 1, 0], {
        filePath: "test2.ts",
        startLine: 10,
        endLine: 15,
        chunkType: "function",
        language: "typescript",
        hash: "def456",
      });

      const results = store.search([1, 0.1, 0], 2);

      expect(results.length).toBe(2);
      expect(results[0].id).toBe("chunk1");
    });

    it("should remove vectors", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      store.remove("chunk1");

      expect(store.count()).toBe(0);
    });

    it("should persist and load", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.save();

      const newStore = new VectorStore(path.join(tempDir, "vectors"), 3);
      newStore.load();

      expect(newStore.count()).toBe(1);
    });

    it("should clear all data", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      store.clear();

      expect(store.count()).toBe(0);
    });

    it("should get all metadata", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });
      store.add("chunk2", [0, 1, 0], {
        filePath: "test2.ts",
        startLine: 10,
        endLine: 15,
        chunkType: "class",
        language: "typescript",
        hash: "def456",
      });

      const metadata = store.getAllMetadata();

      expect(metadata.length).toBe(2);
      expect(metadata.some((m) => m.key === "chunk1")).toBe(true);
      expect(metadata.some((m) => m.key === "chunk2")).toBe(true);
    });

    it("should get metadata for single chunk", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "test.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      const metadata = store.getMetadata("chunk1");
      expect(metadata).toBeDefined();
      expect(metadata?.filePath).toBe("test.ts");
      expect(metadata?.chunkType).toBe("function");

      const missing = store.getMetadata("nonexistent");
      expect(missing).toBeUndefined();
    });

    it("should get metadata batch for multiple chunks", () => {
      store.add("chunk1", [1, 0, 0], {
        filePath: "a.ts",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        language: "typescript",
        hash: "abc123",
      });

      store.add("chunk2", [0, 1, 0], {
        filePath: "b.ts",
        startLine: 10,
        endLine: 15,
        chunkType: "class",
        language: "typescript",
        hash: "def456",
      });

      store.add("chunk3", [0, 0, 1], {
        filePath: "c.ts",
        startLine: 20,
        endLine: 25,
        chunkType: "method",
        language: "typescript",
        hash: "ghi789",
      });

      const metadataMap = store.getMetadataBatch(["chunk1", "chunk3", "nonexistent"]);
      
      expect(metadataMap.size).toBe(2);
      expect(metadataMap.get("chunk1")?.filePath).toBe("a.ts");
      expect(metadataMap.get("chunk3")?.filePath).toBe("c.ts");
      expect(metadataMap.has("chunk2")).toBe(false);
      expect(metadataMap.has("nonexistent")).toBe(false);
    });
  });

  describe("createEmbeddingText", () => {
    it("should create embedding text with metadata", () => {
      const chunk: CodeChunk = {
        content: "function test() { return 1; }",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        name: "test",
        language: "typescript",
      };

      const text = createEmbeddingText(chunk, "/src/utils/helper.ts");

      expect(text).toContain("TypeScript");
      expect(text).toContain("test");
      expect(text).toContain("function test()");
    });

    it("should extract semantic hints", () => {
      const chunk: CodeChunk = {
        content: "async function validateToken(token: string) { return jwt.verify(token); }",
        startLine: 1,
        endLine: 5,
        chunkType: "function",
        name: "validateToken",
        language: "typescript",
      };

      const text = createEmbeddingText(chunk, "/src/auth.ts");

      expect(text.toLowerCase()).toContain("token");
    });
  });

  describe("createDynamicBatches", () => {
    it("should batch chunks by token count", () => {
      const chunks = [
        { text: "a".repeat(1000), id: "1" },
        { text: "b".repeat(1000), id: "2" },
        { text: "c".repeat(1000), id: "3" },
      ];

      const batches = createDynamicBatches(chunks);

      expect(batches.length).toBeGreaterThanOrEqual(1);
      expect(batches.flat().length).toBe(3);
    });

    it("should handle empty input", () => {
      const batches = createDynamicBatches([]);

      expect(batches.length).toBe(0);
    });

    it("should split large chunks into separate batches", () => {
      const chunks = [
        { text: "a".repeat(30000), id: "1" },
        { text: "b".repeat(30000), id: "2" },
      ];

      const batches = createDynamicBatches(chunks);

      expect(batches.length).toBe(2);
    });
  });

  describe("generateChunkId", () => {
    it("should generate consistent IDs", () => {
      const chunk: CodeChunk = {
        content: "function test() {}",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        language: "typescript",
      };

      const id1 = generateChunkId("/path/to/file.ts", chunk);
      const id2 = generateChunkId("/path/to/file.ts", chunk);

      expect(id1).toBe(id2);
    });

    it("should generate different IDs for different chunks", () => {
      const chunk1: CodeChunk = {
        content: "function a() {}",
        startLine: 1,
        endLine: 3,
        chunkType: "function",
        language: "typescript",
      };
      const chunk2: CodeChunk = {
        content: "function b() {}",
        startLine: 5,
        endLine: 7,
        chunkType: "function",
        language: "typescript",
      };

      const id1 = generateChunkId("/path/to/file.ts", chunk1);
      const id2 = generateChunkId("/path/to/file.ts", chunk2);

      expect(id1).not.toBe(id2);
    });

    it("should start with chunk_ prefix", () => {
      const chunk: CodeChunk = {
        content: "const x = 1;",
        startLine: 1,
        endLine: 1,
        chunkType: "other",
        language: "typescript",
      };

      const id = generateChunkId("/file.ts", chunk);

      expect(id.startsWith("chunk_")).toBe(true);
    });
  });

  describe("estimateTokens", () => {
    it("should estimate ~4 chars per token", () => {
      const text = "a".repeat(400);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(100);
    });
  });
});
