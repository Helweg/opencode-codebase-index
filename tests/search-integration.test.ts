import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

describe("search integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let _indexers: Indexer[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
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

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const stats = await indexer.index();
    expect(stats.totalFiles).toBeGreaterThan(0);

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain(path.join("app", "indexer", "index.ts"));
    expect(topPaths).not.toContain(path.join("tests", "fixtures", "call-graph", "same-file-refs.ts"));
    expect(topPaths).not.toContain(path.join("benchmarks", "run.ts"));
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults documentation guide", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("README.md");
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain(path.join("app", "indexer", "index.ts"));
  });

  it("keeps plain identifier queries discoverable without definitionIntent", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain(path.join("app", "indexer", "index.ts"));
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const withoutOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(withoutOverride[0]?.filePath).toContain("README.md");

    const withOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(withOverride.length).toBeGreaterThan(0);
    expect(withOverride[0]?.filePath).toContain(path.join("app", "indexer", "index.ts"));
    expect(withOverride[0]?.filePath).not.toContain("README.md");
  });

  it("keeps exploratory queries broad instead of forcing definition lanes", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("query length flow", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.slice(0, 3).some((result) => result.filePath.includes(path.join("app", "indexer", "index.ts")))).toBe(true);
    expect(results.slice(0, 5).some((result) => result.filePath.includes("README.md"))).toBe(true);
  });

  it("keeps matching test results in mixed test and implementation queries", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const implPath = path.join(tempDir, "src", "payments", "handler.ts");
    const testPath = path.join(tempDir, "tests", "paymentFunction.test.ts");

    fs.mkdirSync(path.dirname(implPath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(implPath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(testPath, `export function paymentFunction() { return true; }\n`, "utf-8");

    const mocked = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { count(): number; search(): Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }> };
        provider: { embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number }> };
        invertedIndex: unknown;
        configuredProviderInfo: unknown;
        database: {
          getBranchChunkIds(_key: string): string[];
          getSymbolsByName(_name: string): unknown[];
          getSymbolsByNameCi(_name: string): unknown[];
          getChunksByFile(_filePath: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByName(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByNameCi(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
        };
      }>;
      checkCompatibility: () => { compatible: boolean; reason?: string };
      getQueryEmbedding: (_query: string, _provider: unknown) => Promise<number[]>;
      keywordSearch: (_query: string, _limit: number) => Promise<Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }>>;
      currentBranch: string;
      config: typeof config;
    };

    mocked.currentBranch = "default";
    mocked.checkCompatibility = () => ({ compatible: true });
    mocked.getQueryEmbedding = async () => [0.1, 0.2, 0.3];
    mocked.keywordSearch = async () => [];
    mocked.ensureInitialized = async () => ({
      store: {
        count: () => 1,
        search: () => [
          {
            id: "impl",
            score: 0.95,
            metadata: {
              filePath: implPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "impl-hash",
              name: "paymentFunction",
            },
          },
          {
            id: "other",
            score: 0.7,
            metadata: {
              filePath: path.join(tempDir, "app", "indexer", "index.ts"),
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "other-hash",
              name: "rankHybridResults",
            },
          },
        ],
      },
      provider: {
        embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      },
      invertedIndex: {},
      configuredProviderInfo: {},
      database: {
        getBranchChunkIds: () => [],
        getSymbolsByName: () => [],
        getSymbolsByNameCi: () => [],
        getChunksByFile: () => [],
        getChunksByName: () => [],
        getChunksByNameCi: () => [
          {
            chunkId: "test",
            filePath: testPath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "test-hash",
          },
        ],
      },
    });

    const results = await indexer.search("test the paymentFunction function", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
    expect(results.some((result) => result.filePath.includes(path.join("tests", "paymentFunction.test.ts")))).toBe(true);
  });

  it("keeps documentation-oriented symbol queries on the docs path", async () => {
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

    fs.mkdirSync(path.join(tempDir, "src", "payments"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "payments", "handler.ts"),
      `export function paymentFunction() { return true; }\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "README.md"),
      "# Payment docs\n\nDocumentation for paymentFunction function.\n",
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("documentation for the paymentFunction function", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("README.md");
    expect(results.some((result) => result.filePath.includes(path.join("src", "payments", "handler.ts")))).toBe(true);
  });

  it("keeps matching tests visible for mixed 'where is ... test' queries", async () => {
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

    fs.mkdirSync(path.join(tempDir, "src", "payments"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "payments", "handler.ts"),
      `export function paymentFunction() { return true; }\n`,
      "utf-8"
    );
    fs.mkdirSync(path.join(tempDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "tests", "paymentFunction.test.ts"),
      `import { paymentFunction } from "../src/payments/handler";\n\ntest("paymentFunction", () => { expect(paymentFunction()).toBe(true); });\n`,
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("where is paymentFunction function test", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
    expect(results[1]?.filePath).toContain(path.join("tests", "paymentFunction.test.ts"));
  });

  it("keeps real tests ahead of benchmark and docs in the mixed support lane", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const implPath = path.join(tempDir, "src", "payments", "handler.ts");
    const testPath = path.join(tempDir, "tests", "paymentFunction.test.ts");
    const benchmarkPath = path.join(tempDir, "benchmarks", "paymentFunction.ts");
    const fixturePath = path.join(tempDir, "tests", "fixtures", "paymentFunction.ts");
    const readmePath = path.join(tempDir, "README.md");

    fs.mkdirSync(path.dirname(implPath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.mkdirSync(path.dirname(benchmarkPath), { recursive: true });
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(implPath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(testPath, `import { paymentFunction } from "../src/payments/handler";\n\ntest("paymentFunction", () => { expect(paymentFunction()).toBe(true); });\n`, "utf-8");
    fs.writeFileSync(benchmarkPath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(fixturePath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(readmePath, `# Payment docs\n\nThis documents paymentFunction.\n`, "utf-8");

    const mocked = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { count(): number; search(): Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }> };
        provider: { embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number }> };
        invertedIndex: unknown;
        configuredProviderInfo: unknown;
        database: {
          getBranchChunkIds(_key: string): string[];
          getSymbolsByName(_name: string): unknown[];
          getSymbolsByNameCi(_name: string): unknown[];
          getChunksByFile(_filePath: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByName(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByNameCi(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
        };
      }>;
      checkCompatibility: () => { compatible: boolean; reason?: string };
      getQueryEmbedding: (_query: string, _provider: unknown) => Promise<number[]>;
      keywordSearch: (_query: string, _limit: number) => Promise<Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }>>;
      currentBranch: string;
      config: typeof config;
    };

    mocked.currentBranch = "default";
    mocked.checkCompatibility = () => ({ compatible: true });
    mocked.getQueryEmbedding = async () => [0.1, 0.2, 0.3];
    mocked.keywordSearch = async () => [];
    mocked.ensureInitialized = async () => ({
      store: {
        count: () => 1,
        search: () => [
          {
            id: "impl",
            score: 0.95,
            metadata: {
              filePath: implPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "impl-hash",
              name: "paymentFunction",
            },
          },
          {
            id: "docs",
            score: 0.93,
            metadata: {
              filePath: readmePath,
              startLine: 1,
              endLine: 3,
              chunkType: "other",
              language: "markdown",
              hash: "docs-hash",
              name: "paymentFunction docs",
            },
          },
          {
            id: "benchmark",
            score: 0.92,
            metadata: {
              filePath: benchmarkPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "benchmark-hash",
              name: "paymentFunction",
            },
          },
          {
            id: "fixture",
            score: 0.91,
            metadata: {
              filePath: fixturePath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "fixture-hash",
              name: "paymentFunction",
            },
          },
        ],
      },
      provider: {
        embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      },
      invertedIndex: {},
      configuredProviderInfo: {},
      database: {
        getBranchChunkIds: () => [],
        getSymbolsByName: () => [],
        getSymbolsByNameCi: () => [],
        getChunksByFile: () => [],
        getChunksByName: () => [],
        getChunksByNameCi: () => [
          {
            chunkId: "test",
            filePath: testPath,
            startLine: 1,
            endLine: 3,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "test-hash",
          },
          {
            chunkId: "benchmark",
            filePath: benchmarkPath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "benchmark-hash",
          },
          {
            chunkId: "fixture",
            filePath: fixturePath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "fixture-hash",
          },
        ],
      },
    });

    const results = await indexer.search("where is paymentFunction function test", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const resultPaths = results.map((result) => result.filePath);
    const testIndex = resultPaths.indexOf(testPath);
    const benchmarkIndex = resultPaths.indexOf(benchmarkPath);
    const fixtureIndex = resultPaths.indexOf(fixturePath);
    const readmeIndex = resultPaths.indexOf(readmePath);

    expect(results[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
    expect(results[1]?.filePath).toContain(path.join("tests", "paymentFunction.test.ts"));
    expect(testIndex).toBeGreaterThanOrEqual(0);
    expect(benchmarkIndex === -1 || benchmarkIndex > testIndex).toBe(true);
    expect(fixtureIndex === -1 || fixtureIndex > testIndex).toBe(true);
    expect(readmeIndex === -1 || readmeIndex > testIndex).toBe(true);
  });

  it("rescues benchmark matches for explicit benchmark intent", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const implPath = path.join(tempDir, "src", "payments", "handler.ts");
    const benchmarkPath = path.join(tempDir, "benchmarks", "paymentFunction.ts");

    fs.mkdirSync(path.dirname(implPath), { recursive: true });
    fs.mkdirSync(path.dirname(benchmarkPath), { recursive: true });
    fs.writeFileSync(implPath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(benchmarkPath, `export function paymentFunction() { return true; }\n`, "utf-8");

    const mocked = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { count(): number; search(): Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }> };
        provider: { embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number }> };
        invertedIndex: unknown;
        configuredProviderInfo: unknown;
        database: {
          getBranchChunkIds(_key: string): string[];
          getSymbolsByName(_name: string): unknown[];
          getSymbolsByNameCi(_name: string): unknown[];
          getChunksByFile(_filePath: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByName(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByNameCi(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
        };
      }>;
      checkCompatibility: () => { compatible: boolean; reason?: string };
      getQueryEmbedding: (_query: string, _provider: unknown) => Promise<number[]>;
      keywordSearch: (_query: string, _limit: number) => Promise<Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }>>;
      currentBranch: string;
      config: typeof config;
    };

    mocked.currentBranch = "default";
    mocked.checkCompatibility = () => ({ compatible: true });
    mocked.getQueryEmbedding = async () => [0.1, 0.2, 0.3];
    mocked.keywordSearch = async () => [];
    mocked.ensureInitialized = async () => ({
      store: {
        count: () => 1,
        search: () => [
          {
            id: "impl",
            score: 0.95,
            metadata: {
              filePath: implPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "impl-hash",
              name: "paymentFunction",
            },
          },
        ],
      },
      provider: {
        embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      },
      invertedIndex: {},
      configuredProviderInfo: {},
      database: {
        getBranchChunkIds: () => [],
        getSymbolsByName: () => [],
        getSymbolsByNameCi: () => [],
        getChunksByFile: () => [],
        getChunksByName: () => [],
        getChunksByNameCi: () => [
          {
            chunkId: "benchmark",
            filePath: benchmarkPath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "benchmark-hash",
          },
        ],
      },
    });

    const results = await indexer.search("where is paymentFunction function benchmark", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
    expect(results.some((result) => result.filePath === benchmarkPath)).toBe(true);
  });

  it("rescues fixture matches for explicit fixture intent", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const implPath = path.join(tempDir, "src", "payments", "handler.ts");
    const fixturePath = path.join(tempDir, "tests", "fixtures", "paymentFunction.ts");

    fs.mkdirSync(path.dirname(implPath), { recursive: true });
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(implPath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(fixturePath, `export function paymentFunction() { return true; }\n`, "utf-8");

    const mocked = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { count(): number; search(): Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }> };
        provider: { embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number }> };
        invertedIndex: unknown;
        configuredProviderInfo: unknown;
        database: {
          getBranchChunkIds(_key: string): string[];
          getSymbolsByName(_name: string): unknown[];
          getSymbolsByNameCi(_name: string): unknown[];
          getChunksByFile(_filePath: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByName(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByNameCi(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
        };
      }>;
      checkCompatibility: () => { compatible: boolean; reason?: string };
      getQueryEmbedding: (_query: string, _provider: unknown) => Promise<number[]>;
      keywordSearch: (_query: string, _limit: number) => Promise<Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }>>;
      currentBranch: string;
      config: typeof config;
    };

    mocked.currentBranch = "default";
    mocked.checkCompatibility = () => ({ compatible: true });
    mocked.getQueryEmbedding = async () => [0.1, 0.2, 0.3];
    mocked.keywordSearch = async () => [];
    mocked.ensureInitialized = async () => ({
      store: {
        count: () => 1,
        search: () => [
          {
            id: "impl",
            score: 0.95,
            metadata: {
              filePath: implPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "impl-hash",
              name: "paymentFunction",
            },
          },
        ],
      },
      provider: {
        embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      },
      invertedIndex: {},
      configuredProviderInfo: {},
      database: {
        getBranchChunkIds: () => [],
        getSymbolsByName: () => [],
        getSymbolsByNameCi: () => [],
        getChunksByFile: () => [],
        getChunksByName: () => [],
        getChunksByNameCi: () => [
          {
            chunkId: "fixture",
            filePath: fixturePath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "fixture-hash",
          },
        ],
      },
    });

    const results = await indexer.search("where is paymentFunction function fixture", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.some((result) => result.filePath === fixturePath)).toBe(true);
    expect(results.some((result) => result.filePath === implPath)).toBe(true);
  });

  it("rescues Windows-style fixture paths for explicit fixture intent", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const implPath = path.join(tempDir, "src", "payments", "handler.ts");
    const fixturePath = "C:\\repo\\tests\\fixtures\\paymentFunction.ts";

    fs.mkdirSync(path.dirname(implPath), { recursive: true });
    fs.writeFileSync(implPath, `export function paymentFunction() { return true; }\n`, "utf-8");

    const mocked = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { count(): number; search(): Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }> };
        provider: { embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number }> };
        invertedIndex: unknown;
        configuredProviderInfo: unknown;
        database: {
          getBranchChunkIds(_key: string): string[];
          getSymbolsByName(_name: string): unknown[];
          getSymbolsByNameCi(_name: string): unknown[];
          getChunksByFile(_filePath: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByName(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByNameCi(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
        };
      }>;
      checkCompatibility: () => { compatible: boolean; reason?: string };
      getQueryEmbedding: (_query: string, _provider: unknown) => Promise<number[]>;
      keywordSearch: (_query: string, _limit: number) => Promise<Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }>>;
      currentBranch: string;
      config: typeof config;
    };

    mocked.currentBranch = "default";
    mocked.checkCompatibility = () => ({ compatible: true });
    mocked.getQueryEmbedding = async () => [0.1, 0.2, 0.3];
    mocked.keywordSearch = async () => [];
    mocked.ensureInitialized = async () => ({
      store: {
        count: () => 1,
        search: () => [
          {
            id: "impl",
            score: 0.95,
            metadata: {
              filePath: implPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "impl-hash",
              name: "paymentFunction",
            },
          },
        ],
      },
      provider: {
        embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      },
      invertedIndex: {},
      configuredProviderInfo: {},
      database: {
        getBranchChunkIds: () => [],
        getSymbolsByName: () => [],
        getSymbolsByNameCi: () => [],
        getChunksByFile: () => [],
        getChunksByName: () => [],
        getChunksByNameCi: () => [
          {
            chunkId: "fixture-win",
            filePath: fixturePath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "fixture-win-hash",
          },
        ],
      },
    });

    const results = await indexer.search("where is paymentFunction function fixture", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.some((result) => result.filePath === fixturePath)).toBe(true);
    expect(results.some((result) => result.filePath === implPath)).toBe(true);
  });

  it("keeps benchmark-named test files in the real-test lane for generic test queries", async () => {
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    const implPath = path.join(tempDir, "src", "payments", "handler.ts");
    const benchmarkNamedTestPath = path.join(tempDir, "tests", "benchmarking", "payment.test.ts");
    const benchmarkPath = path.join(tempDir, "benchmarks", "paymentFunction.ts");

    fs.mkdirSync(path.dirname(implPath), { recursive: true });
    fs.mkdirSync(path.dirname(benchmarkNamedTestPath), { recursive: true });
    fs.mkdirSync(path.dirname(benchmarkPath), { recursive: true });
    fs.writeFileSync(implPath, `export function paymentFunction() { return true; }\n`, "utf-8");
    fs.writeFileSync(benchmarkNamedTestPath, `import { paymentFunction } from "../../src/payments/handler";\n\ntest("paymentFunction benchmark helper", () => { expect(paymentFunction()).toBe(true); });\n`, "utf-8");
    fs.writeFileSync(benchmarkPath, `export function paymentFunction() { return true; }\n`, "utf-8");

    const mocked = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { count(): number; search(): Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }> };
        provider: { embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number }> };
        invertedIndex: unknown;
        configuredProviderInfo: unknown;
        database: {
          getBranchChunkIds(_key: string): string[];
          getSymbolsByName(_name: string): unknown[];
          getSymbolsByNameCi(_name: string): unknown[];
          getChunksByFile(_filePath: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByName(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
          getChunksByNameCi(_name: string): Array<{ chunkId: string; filePath: string; startLine: number; endLine: number; nodeType: string; name?: string; language: string; contentHash: string }>;
        };
      }>;
      checkCompatibility: () => { compatible: boolean; reason?: string };
      getQueryEmbedding: (_query: string, _provider: unknown) => Promise<number[]>;
      keywordSearch: (_query: string, _limit: number) => Promise<Array<{ id: string; score: number; metadata: { filePath: string; startLine: number; endLine: number; chunkType: string; language: string; hash: string; name?: string } }>>;
      currentBranch: string;
      config: typeof config;
    };

    mocked.currentBranch = "default";
    mocked.checkCompatibility = () => ({ compatible: true });
    mocked.getQueryEmbedding = async () => [0.1, 0.2, 0.3];
    mocked.keywordSearch = async () => [];
    mocked.ensureInitialized = async () => ({
      store: {
        count: () => 1,
        search: () => [
          {
            id: "impl",
            score: 0.95,
            metadata: {
              filePath: implPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "impl-hash",
              name: "paymentFunction",
            },
          },
          {
            id: "bench-noise",
            score: 0.92,
            metadata: {
              filePath: benchmarkPath,
              startLine: 1,
              endLine: 1,
              chunkType: "function",
              language: "typescript",
              hash: "benchmark-hash",
              name: "paymentFunction",
            },
          },
        ],
      },
      provider: {
        embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      },
      invertedIndex: {},
      configuredProviderInfo: {},
      database: {
        getBranchChunkIds: () => [],
        getSymbolsByName: () => [],
        getSymbolsByNameCi: () => [],
        getChunksByFile: () => [],
        getChunksByName: () => [],
        getChunksByNameCi: () => [
          {
            chunkId: "benchmark-test",
            filePath: benchmarkNamedTestPath,
            startLine: 1,
            endLine: 3,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "benchmark-test-hash",
          },
          {
            chunkId: "bench-noise",
            filePath: benchmarkPath,
            startLine: 1,
            endLine: 1,
            nodeType: "function",
            name: "paymentFunction",
            language: "typescript",
            contentHash: "benchmark-hash",
          },
        ],
      },
    });

    const results = await indexer.search("where is paymentFunction function test", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const resultPaths = results.map((result) => result.filePath);
    const testIndex = resultPaths.indexOf(benchmarkNamedTestPath);
    const benchmarkIndex = resultPaths.indexOf(benchmarkPath);

    expect(results[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
    expect(testIndex).toBeGreaterThanOrEqual(0);
    expect(benchmarkIndex === -1 || benchmarkIndex > testIndex).toBe(true);
  });

  it("keeps short mixed 'where is ... test' queries source-first", async () => {
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

    fs.mkdirSync(path.join(tempDir, "src", "payments"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "payments", "handler.ts"),
      `export function paymentFunction() { return true; }\n`,
      "utf-8"
    );
    fs.mkdirSync(path.join(tempDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "tests", "paymentFunction.test.ts"),
      `import { paymentFunction } from "../src/payments/handler";\n\ntest("paymentFunction", () => { expect(paymentFunction()).toBe(true); });\n`,
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("where is paymentFunction test", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
    expect(results[1]?.filePath).toContain(path.join("tests", "paymentFunction.test.ts"));
  });

  it("keeps 'where is ... documentation' queries on docs unless definition intent is forced", async () => {
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

    fs.mkdirSync(path.join(tempDir, "src", "payments"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "payments", "handler.ts"),
      `export function paymentFunction() { return true; }\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "README.md"),
      "# Payment docs\n\nWhere is paymentFunction function documentation? Right here.\n",
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const withoutOverride = await indexer.search("where is paymentFunction function documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(withoutOverride[0]?.filePath).toContain("README.md");

    const withOverride = await indexer.search("where is paymentFunction function documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });
    expect(withOverride[0]?.filePath).toContain(path.join("src", "payments", "handler.ts"));
  });

  it("rescues lowercase explicit implementation lookups through the primary lane", async () => {
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

    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "validate.ts"),
      `export function validate() { return true; }\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "README.md"),
      "# Validation docs\n\nwhere is validate implementation guide\n",
      "utf-8"
    );
    fs.mkdirSync(path.join(tempDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "tests", "validate.test.ts"),
      `export function validate() { return true; }\n`,
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("where is validate implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const topPaths = results.slice(0, 3).map((result) => result.filePath);
    expect(topPaths).toContain(path.join(tempDir, "src", "validate.ts"));
    expect(topPaths.indexOf(path.join(tempDir, "src", "validate.ts"))).toBeLessThan(topPaths.indexOf(path.join(tempDir, "README.md")) === -1 ? topPaths.length : topPaths.indexOf(path.join(tempDir, "README.md")));
    expect(topPaths.indexOf(path.join(tempDir, "src", "validate.ts"))).toBeLessThan(topPaths.indexOf(path.join(tempDir, "tests", "validate.test.ts")) === -1 ? topPaths.length : topPaths.indexOf(path.join(tempDir, "tests", "validate.test.ts")));
  });

  it("keeps broad discovery queries out of definition-first collapse", async () => {
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

    fs.mkdirSync(path.join(tempDir, "src", "ranking"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "ranking", "flow.ts"),
      `export function buildRankingFlow() { return "flow"; }\n`,
      "utf-8"
    );
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "docs", "ranking-flow.md"),
      "# Ranking Flow\n\nThis document explains where the ranking flow happens.\n",
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("where does ranking flow happen", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.some((result) => result.filePath.includes(path.join("src", "ranking", "flow.ts")))).toBe(true);
    expect(results.some((result) => result.filePath.includes(path.join("docs", "ranking-flow.md")))).toBe(true);
  });

  it("keeps implementation results ahead of docs even when external reranker prefers docs for implementation intent", async () => {
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.99 },
            { index: 1, relevance_score: 0.5 },
          ],
        }), { status: 200 });
      }

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

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 10,
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("app", "indexer", "index.ts"));
    expect(results[0]?.filePath).not.toContain("README.md");
  });

  it("keeps documentation results ahead of code when external reranker prefers code for doc intent", async () => {
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.4 },
          ],
        }), { status: 200 });
      }

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

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 10,
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults documentation guide", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("README.md");
    expect(results[0]?.filePath).not.toContain(path.join("app", "indexer", "index.ts"));
  });
});
