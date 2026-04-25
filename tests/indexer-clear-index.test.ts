import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";
import { hashContent } from "../src/native/index.js";

describe("indexer clearIndex force rebuild", () => {
  let tempDir: string;
  let sourceFile: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let embeddingDimensions = 8;
  let tempHome: string;

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
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clear-index-home-"));
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
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createIndexer(projectRoot: string, dimensions: number, scope: "project" | "global" = "project"): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: `mock-${dimensions}d`,
        dimensions,
      },
      scope,
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return new Indexer(projectRoot, config);
  }

  it("clears persisted embeddings before a force rebuild with new dimensions", async () => {
    embeddingDimensions = 8;
    const originalIndexer = createIndexer(tempDir, 8);
    const originalStats = await originalIndexer.index();
    expect(originalStats.failedChunks).toBe(0);
    expect(originalStats.indexedChunks).toBeGreaterThan(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const seededDb = new Database(dbPath);
    expect(seededDb.getStats().embeddingCount).toBeGreaterThan(0);

    embeddingDimensions = 4;
    const rebuiltIndexer = createIndexer(tempDir, 4);
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

  it("clears only the current project from a shared global index when compatibility is unchanged", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    const indexerA = createIndexer(projectA, 8, "global");
    const indexerB = createIndexer(projectB, 8, "global");

    await indexerA.index();
    await indexerB.index();

    await indexerA.clearIndex();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    expect(db.getChunksByFile(projectAFile)).toHaveLength(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);

    const remainingChunk = db.getChunksByFile(projectBFile)[0];
    const remainingBranch = db.getAllBranches().find((branch) => branch.endsWith(":default"));
    expect(remainingBranch).toBeTruthy();
    expect(db.chunkExistsOnBranch(remainingBranch!, remainingChunk.chunkId)).toBe(true);
    expect(db.getStats().embeddingCount).toBeGreaterThan(0);

    const fileHashCachePath = path.join(tempHome, ".opencode", "global-index", "file-hashes.json");
    const fileHashCache = JSON.parse(fs.readFileSync(fileHashCachePath, "utf-8")) as Record<string, string>;
    expect(fileHashCache[projectAFile]).toBeUndefined();
    expect(typeof fileHashCache[projectBFile]).toBe("string");
  });

  it("rejects an incompatible global force reset when the shared index contains other projects", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    embeddingDimensions = 8;
    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    embeddingDimensions = 4;
    const incompatibleIndexer = createIndexer(projectA, 4, "global");

    await expect(incompatibleIndexer.clearIndex()).rejects.toThrow(
      "Global index compatibility reset is unsafe"
    );

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    expect(db.getChunksByFile(projectAFile).length).toBeGreaterThan(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);
  });

  it("allows an incompatible global force reset when the current project is the only indexed tenant", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    embeddingDimensions = 8;
    await createIndexer(projectA, 8, "global").index();

    embeddingDimensions = 4;
    const rebuiltIndexer = createIndexer(projectA, 4, "global");
    await rebuiltIndexer.clearIndex();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    expect(db.getStats().embeddingCount).toBe(0);
    expect(db.getStats().chunkCount).toBe(0);

    const rebuiltStats = await rebuiltIndexer.index();
    expect(rebuiltStats.failedChunks).toBe(0);
    expect(rebuiltStats.indexedChunks).toBeGreaterThan(0);
  });

  it("resets a corrupted local sqlite index during health check and reports rebuild guidance", async () => {
    embeddingDimensions = 8;
    const indexer = createIndexer(tempDir, 8);
    const stats = await indexer.index();
    expect(stats.indexedChunks).toBeGreaterThan(0);

    const database = (indexer as unknown as { database: Database }).database;
    vi.spyOn(database, "gcOrphanEmbeddings").mockReturnValue(0);
    vi.spyOn(database, "gcOrphanChunks").mockImplementation(() => {
      throw new Error("SQLite error: database disk image is malformed");
    });

    const result = await indexer.healthCheck();
    expect(result.resetCorruptedIndex).toBe(true);
    expect(result.warning).toContain("reset the local index");

    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBe(0);
  });

  it("refuses to auto-reset a corrupted shared global sqlite index", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    const indexer = createIndexer(projectA, 8, "global");
    await indexer.index();

    const database = (indexer as unknown as { database: Database }).database;
    vi.spyOn(database, "gcOrphanEmbeddings").mockReturnValue(0);
    vi.spyOn(database, "gcOrphanChunks").mockImplementation(() => {
      throw new Error("SQLite error: database disk image is malformed");
    });

    await expect(indexer.healthCheck()).rejects.toThrow("Automatic repair is disabled for global scope");
  });

  it("surfaces rebuild guidance when automatic orphan GC resets a corrupted local index", async () => {
    embeddingDimensions = 8;
    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
        autoGc: true,
        gcOrphanThreshold: 0,
      },
    }));

    const initialStats = await indexer.index();
    expect(initialStats.indexedChunks).toBeGreaterThan(0);

    const database = (indexer as unknown as { database: Database }).database;
    vi.spyOn(database, "getStats").mockReturnValue({
      embeddingCount: 2,
      chunkCount: 1,
      branchChunkCount: 1,
      branchCount: 1,
      symbolCount: 0,
      callEdgeCount: 0,
    });
    const realGcOrphanEmbeddings = database.gcOrphanEmbeddings.bind(database);
    vi.spyOn(database, "gcOrphanEmbeddings").mockImplementation(() => realGcOrphanEmbeddings());
    vi.spyOn(database, "gcOrphanChunks").mockImplementation(() => {
      throw new Error("SQLite error: database disk image is malformed");
    });

    const maybeRunOrphanGc = vi.spyOn(indexer as unknown as { maybeRunOrphanGc: () => Promise<unknown> }, "maybeRunOrphanGc");

    fs.writeFileSync(sourceFile, [
      "export function alpha() {",
      "  return 'alpha-updated';",
      "}",
      "",
      "export function gamma() {",
      "  return alpha();",
      "}",
    ].join("\n"), "utf-8");

    const result = await indexer.index();
    expect(maybeRunOrphanGc).toHaveBeenCalled();
    expect(result.resetCorruptedIndex).toBe(true);
    expect(result.warning).toContain("reset the local index");

    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBe(0);
  });

  it("preserves shared knowledge-base rows still referenced by another global project", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const kbDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const kbFile = path.join(kbDir, "docs", "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");
    fs.writeFileSync(kbFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [kbDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    }));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();
    await createKbIndexer(projectA).clearIndex();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    expect(db.getChunksByFile(projectAFile)).toHaveLength(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);
    expect(db.getChunksByFile(kbFile).length).toBeGreaterThan(0);

    const searchResults = await createKbIndexer(projectB).search("sharedDoc", 5);
    expect(searchResults.some((result) => result.filePath === kbFile)).toBe(true);
  });

  it("keeps legacy global branch catalogs readable across repos until each project is reindexed", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    const projectBChunk = db.getChunksByFile(projectBFile)[0];
    const projectAKey = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBKey = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;

    db.clearBranch(projectBKey);
    db.addChunksToBranchBatch("default", [projectBChunk.chunkId]);
    db.deleteMetadata(`index.globalBranchMigration.${hashContent(path.resolve(projectB)).slice(0, 16)}`);
    db.clearBranch(projectAKey);

    const searchResults = await createIndexer(projectB, 8, "global").search("beta", 5);
    expect(searchResults.some((result) => result.filePath === projectBFile)).toBe(true);
  });

  it("stops reading legacy global branch rows for a repo after that repo is reindexed", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    const projectAChunk = db.getChunksByFile(projectAFile)[0];
    const projectBChunk = db.getChunksByFile(projectBFile)[0];
    const projectAKey = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBKey = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;

    db.clearBranch(projectAKey);
    db.addChunksToBranchBatch("default", [projectAChunk.chunkId]);
    db.deleteMetadata(`index.globalBranchMigration.${hashContent(path.resolve(projectA)).slice(0, 16)}`);

    const legacyVisibleResults = await createIndexer(projectA, 8, "global").search("alpha", 5);
    expect(legacyVisibleResults.some((result) => result.filePath === projectAFile)).toBe(true);

    await createIndexer(projectA, 8, "global").index();

    db.clearBranch(projectAKey);
    db.addChunksToBranchBatch("default", [projectBChunk.chunkId]);

    const isolatedResults = await createIndexer(projectA, 8, "global").search("beta", 5);
    expect(isolatedResults.some((result) => result.filePath === projectBFile)).toBe(false);
    expect(db.getMetadata(`index.globalBranchMigration.${hashContent(path.resolve(projectA)).slice(0, 16)}`)).toBe("done");
    expect(db.getBranchChunkIds(projectBKey).length).toBeGreaterThan(0);
  });

  it("clears both legacy and namespaced branch rows for the current repo during global force reset", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    const indexerA = createIndexer(projectA, 8, "global");
    await indexerA.index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    const projectAChunk = db.getChunksByFile(projectAFile)[0];
    const namespacedBranch = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;

    db.addChunksToBranchBatch("default", [projectAChunk.chunkId]);

    await indexerA.clearIndex();

    expect(db.chunkExistsOnBranch(namespacedBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.chunkExistsOnBranch("default", projectAChunk.chunkId)).toBe(false);

    const rebuiltStats = await createIndexer(projectA, 8, "global").index();
    expect(rebuiltStats.failedChunks).toBe(0);

    const searchResults = await createIndexer(projectA, 8, "global").search("alpha", 5);
    expect(searchResults.filter((result) => result.filePath === projectAFile)).toHaveLength(1);
  });

  it("preserves foreign failed-batch and file-hash state during global clear when no vectors exist yet", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    const projectAIndexer = createIndexer(projectA, 8, "global");

    await projectAIndexer.index();
    const fileHashCachePath = path.join(tempHome, ".opencode", "global-index", "file-hashes.json");
    fs.writeFileSync(
      fileHashCachePath,
      JSON.stringify({ [projectAFile]: "project-a-hash", [projectBFile]: "foreign-hash" }, null, 2),
      "utf-8"
    );

    const failedBatchesPath = path.join(tempHome, ".opencode", "global-index", "failed-batches.json");
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
      {
        chunks: [
          {
            id: "pending-beta",
            text: "beta pending",
            content: "export function beta() { return 'b'; }",
            contentHash: "pending-hash",
            metadata: {
              filePath: projectBFile,
              startLine: 1,
              endLine: 1,
              language: "typescript",
              chunkType: "function",
              hash: "pending-hash",
              name: "beta",
            },
          },
        ],
        error: "simulated failure",
        attemptCount: 1,
        lastAttempt: new Date().toISOString(),
      },
      ], null, 2),
      "utf-8"
    );

    await projectAIndexer.clearIndex();

    const fileHashCache = JSON.parse(fs.readFileSync(fileHashCachePath, "utf-8")) as Record<string, string>;
    expect(fileHashCache[projectBFile]).toBe("foreign-hash");

    const failedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{ chunks: Array<{ metadata: { filePath: string } }> }>;
    expect(failedBatches.some((batch) => batch.chunks.some((chunk) => chunk.metadata.filePath === projectBFile))).toBe(true);
  });

  it("clears current-repo branch ownership for DB-only chunks left by failed embeddings", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const sharedDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const sharedFile = path.join(sharedDir, "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(sharedFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [sharedDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    }));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    const projectABranch = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBBranch = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;
    const sharedChunk = db.getChunksByFile(sharedFile)[0];

    db.deleteBranchChunksForBranch(projectABranch, [sharedChunk.chunkId]);
    db.deleteBranchChunksForBranch(projectBBranch, [sharedChunk.chunkId]);
    db.deleteChunksByFile(sharedFile);
    db.upsertChunksBatch([
      {
        chunkId: sharedChunk.chunkId,
        contentHash: sharedChunk.contentHash,
        filePath: sharedFile,
        startLine: sharedChunk.startLine,
        endLine: sharedChunk.endLine,
        nodeType: sharedChunk.nodeType,
        name: sharedChunk.name,
        language: sharedChunk.language,
      },
    ]);
    db.addChunksToBranchBatch(projectABranch, [sharedChunk.chunkId]);

    await createKbIndexer(projectA).clearIndex();

    expect(db.chunkExistsOnBranch(projectABranch, sharedChunk.chunkId)).toBe(false);
    expect(db.getChunksByFile(sharedFile)).toHaveLength(0);
  });

  it("preserves resolved call edges for shared symbols kept by another global project", async () => {
    vi.stubEnv("HOME", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const sharedDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const sharedFile = path.join(sharedDir, "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return sharedHelper(); }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedHelper(); }\n", "utf-8");
    fs.writeFileSync(sharedFile, "export const shared = 'shared';\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [sharedDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    }));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = new Database(dbPath);
    const projectABranch = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBBranch = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;

    const sharedSymbolId = `sym_${hashContent(`${sharedFile}:sharedHelper:function:1`).slice(0, 16)}`;
    const betaSymbolId = `sym_${hashContent(`${projectBFile}:beta:function:1`).slice(0, 16)}`;
    const edgeId = `edge_${hashContent(`${betaSymbolId}:sharedHelper:1:0`).slice(0, 16)}`;

    db.upsertSymbolsBatch([
      {
        id: sharedSymbolId,
        filePath: sharedFile,
        name: "sharedHelper",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 30,
        language: "typescript",
      },
      {
        id: betaSymbolId,
        filePath: projectBFile,
        name: "beta",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 40,
        language: "typescript",
      },
    ]);
    db.upsertCallEdgesBatch([
      {
        id: edgeId,
        fromSymbolId: betaSymbolId,
        targetName: "sharedHelper",
        toSymbolId: sharedSymbolId,
        callType: "Call",
        line: 1,
        col: 0,
        isResolved: true,
      },
    ]);
    db.addSymbolsToBranchBatch(projectABranch, [sharedSymbolId]);
    db.addSymbolsToBranchBatch(projectBBranch, [sharedSymbolId, betaSymbolId]);

    await createKbIndexer(projectA).clearIndex();

    const callers = await createKbIndexer(projectB).getCallers("sharedHelper");
    expect(callers.some((caller) => caller.id === edgeId && caller.fromSymbolFilePath === projectBFile)).toBe(true);
  });
});
