import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

describe("indexer clearIndex force rebuild", () => {
  let tempDir: string;
  let sourceFile: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let embeddingDimensions = 8;

  beforeEach(() => {
    embeddingDimensions = 8;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from(
          { length: embeddingDimensions },
          (_, idx) => ((seed + idx * 17) % 997) / 997
        );
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * embeddingDimensions) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-index-indexer-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    sourceFile = path.join(tempDir, "src", "index.ts");
    fs.writeFileSync(
      sourceFile,
      [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return alpha();",
        "}",
      ].join("\n"),
      "utf-8"
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createIndexer(dimensions: number): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: `mock-${dimensions}d`,
        dimensions,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return new Indexer(tempDir, config);
  }

  it("clears persisted embeddings before a force rebuild with new dimensions", async () => {
    embeddingDimensions = 8;
    const originalIndexer = createIndexer(8);
    const originalStats = await originalIndexer.index();
    expect(originalStats.failedChunks).toBe(0);
    expect(originalStats.indexedChunks).toBeGreaterThan(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const seededDb = new Database(dbPath);
    expect(seededDb.getStats().embeddingCount).toBeGreaterThan(0);

    embeddingDimensions = 4;
    const rebuiltIndexer = createIndexer(4);
    await rebuiltIndexer.clearIndex();

    const clearedDb = new Database(dbPath);
    expect(clearedDb.getStats().embeddingCount).toBe(0);
    expect(clearedDb.getStats().chunkCount).toBe(0);
    expect(clearedDb.getStats().branchChunkCount).toBe(0);

    const rebuiltStats = await rebuiltIndexer.index();
    expect(rebuiltStats.failedChunks).toBe(0);
    expect(rebuiltStats.indexedChunks).toBeGreaterThan(0);

    const rebuiltDb = new Database(dbPath);
    const rebuiltBranch = rebuiltDb.getAllBranches()[0];
    expect(rebuiltBranch).toBeTruthy();
    const rebuiltChunkId = rebuiltDb.getBranchChunkIds(rebuiltBranch!)[0];
    expect(rebuiltChunkId).toBeTruthy();
    const rebuiltChunk = rebuiltDb.getChunk(rebuiltChunkId!);
    expect(rebuiltChunk).not.toBeNull();
    const embeddingBuffer = rebuiltDb.getEmbedding(rebuiltChunk!.contentHash);
    expect(embeddingBuffer).not.toBeNull();
    const floatCount = embeddingBuffer!.byteLength / Float32Array.BYTES_PER_ELEMENT;
    expect(floatCount).toBe(4);
  });
});
