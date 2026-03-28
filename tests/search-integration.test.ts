import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

describe("search integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-integration-"));

    fs.mkdirSync(path.join(tempDir, "app", "indexer"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "tests", "fixtures", "call-graph"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "benchmarks"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "app", "indexer", "index.ts"),
      `export function rankHybridResults(query: string) { return query.length; }
export function rerankResults(query: string) { return rankHybridResults(query); }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "tests", "fixtures", "call-graph", "same-file-refs.ts"),
      `function entryPoint() { return "where is rankHybridResults implementation fixture rankHybridResults"; }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "benchmarks", "run.ts"),
      `export function runBenchmarks() { return "rankHybridResults benchmark implementation"; }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "README.md"),
      "# Retrieval Documentation\n\nThis doc explains rankHybridResults usage.",
      "utf-8"
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns implementation definitions before fixture/benchmark noise for implementation-intent query", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = new Indexer(tempDir, config);
    const stats = await indexer.index();
    expect(stats.totalFiles).toBeGreaterThan(0);

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain("/app/indexer/index.ts");
    expect(topPaths).not.toContain("/tests/fixtures/call-graph/same-file-refs.ts");
    expect(topPaths).not.toContain("/benchmarks/run.ts");
  });

  it("prefers documentation paths for doc-intent phrasing with 'where is'", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const results = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("/README.md");
  });

  it("returns implementation definitions with definitionIntent option even for ambiguous queries", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain("/app/indexer/index.ts");
  });

  it("forces definition lanes for doc-leaning queries when definitionIntent is true", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const withoutOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(withoutOverride[0]?.filePath).toContain("/README.md");

    const withOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(withOverride.length).toBeGreaterThan(0);
    expect(withOverride[0]?.filePath).toContain("/app/indexer/index.ts");
    expect(withOverride[0]?.filePath).not.toContain("/README.md");
  });
});
