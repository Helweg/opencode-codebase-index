import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { formatStatus } from "../src/tools/utils.js";

describe("indexer failed batch recovery", () => {
  let tempDir: string;
  let sourceFile: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let failEmbeddings = false;

  beforeEach(() => {
    failEmbeddings = false;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      if (failEmbeddings) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      }

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-batches-indexer-"));
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

  function createIndexer(): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return new Indexer(tempDir, config);
  }

  it("retries saved failed batches on a later successful rerun without force", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    const failedStats = await indexer.index();
    expect(failedStats.failedChunks).toBeGreaterThan(0);

    const failedStatus = await indexer.getStatus();
    expect(failedStatus.indexed).toBe(false);
    expect(failedStatus.failedBatchesCount).toBeGreaterThan(0);

    failEmbeddings = false;
    const recoveredStats = await indexer.index();
    expect(recoveredStats.failedChunks).toBe(0);
    expect(recoveredStats.indexedChunks).toBeGreaterThan(0);

    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(recoveredStatus.failedBatchesCount).toBe(0);
    expect(recoveredStatus.failedBatchesPath).toBeUndefined();
  });

  it("clears stale failed batch warnings after a clean no-op run", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    await indexer.index();

    failEmbeddings = false;
    await indexer.index();

    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.failedBatchesCount).toBe(0);

    const noopStats = await indexer.index();
    expect(noopStats.failedChunks).toBe(0);

    const noopStatus = await indexer.getStatus();
    expect(noopStatus.indexed).toBe(true);
    expect(noopStatus.failedBatchesCount).toBe(0);
    expect(noopStatus.failedBatchesPath).toBeUndefined();
  });

  it("mentions force reruns in not-indexed failed batch guidance", () => {
    const message = formatStatus({
      indexed: false,
      vectorCount: 0,
      provider: "google",
      model: "gemini-embedding-001",
      indexPath: "/tmp/index",
      currentBranch: "default",
      baseBranch: "default",
      compatibility: null,
      failedBatchesCount: 2,
      failedBatchesPath: "/tmp/index/failed-batches.json",
    });

    expect(message).toContain("force=true");
    expect(message).toContain("retry the saved failed batches");
  });
});
