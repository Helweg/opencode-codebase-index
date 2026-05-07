/**
 * Migrates an existing SQLite-backed codebase index to a pgvector database.
 *
 * What is migrated:
 *   - File hashes (avoids re-hashing files on the next index run)
 *   - Chunks + chunk metadata
 *   - Embedding BYTEA cache (avoids re-calling the embedding API)
 *   - Vectors into the pgvector table (derived from the BYTEA embeddings)
 *   - Branch chunk catalog
 *   - Symbols + branch symbol catalog
 *   - Call edges
 *   - Inverted index posting tables (BM25), rebuilt by reading the source files
 *
 * What is NOT migrated:
 *   - Index metadata (index.version, embeddingProvider, etc.) — re-written on next index run
 *   - Lock state — fresh start in pgvector
 */

import * as path from "path";
import { existsSync, readFileSync } from "fs";

import { parseConfig } from "../config/schema.js";
import { loadMergedConfig } from "../config/merger.js";
import { resolveProjectIndexPath } from "../config/paths.js";
import { createDatabaseBackend, createVectorStoreBackend } from "../db/index.js";
import { SqliteDatabaseBackend } from "../db/sqlite-backend.js";
import type { ChunkMetadata } from "../db/backend.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MigrationStats {
  fileHashCount: number;
  chunkCount: number;
  embeddingCount: number;
  vectorCount: number;
  branchCount: number;
  symbolCount: number;
  callEdgeCount: number;
  invertedIndexChunkCount: number;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ── Core migration function ──────────────────────────────────────────────────

/**
 * Reads all data from the SQLite index at `sqliteIndexPath` and writes it into
 * the already-initialized `targetDb` / `targetStore` (pgvector backends).
 *
 * Both backends must already be initialized before calling this function.
 * The function opens its own read-only SQLite connection for the source.
 */
async function runMigration(
  sqliteIndexPath: string,
  targetDb: import("../db/backend.js").IDatabaseBackend,
  targetStore: import("../db/backend.js").IVectorStoreBackend,
  onProgress: (step: string, detail?: string) => void,
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    fileHashCount: 0,
    chunkCount: 0,
    embeddingCount: 0,
    vectorCount: 0,
    branchCount: 0,
    symbolCount: 0,
    callEdgeCount: 0,
    invertedIndexChunkCount: 0,
  };

  const sqliteDbPath = path.join(sqliteIndexPath, "codebase.db");
  if (!existsSync(sqliteDbPath)) {
    throw new Error(`No SQLite database found at ${sqliteDbPath}`);
  }

  const sourceDb = new SqliteDatabaseBackend(sqliteDbPath);
  await sourceDb.initialize();

  try {
    // ── 1. File hashes ───────────────────────────────────────────────────────
    onProgress("Migrating file hashes...");
    const rawFileHashes = await sourceDb.getAllFileHashes();

    // The SQLite backend stores both plain `filePath` keys and
    // source-scoped `sourceId::filePath` keys.  Only copy plain paths.
    const fileHashes = new Map<string, string>();
    for (const [key, hash] of rawFileHashes) {
      if (!key.includes("::")) {
        fileHashes.set(key, hash);
      }
    }
    await targetDb.setFileHashesBatch(fileHashes);
    stats.fileHashCount = fileHashes.size;

    // File paths drive the rest of the migration.
    const filePaths = Array.from(fileHashes.keys());

    // ── 2. Chunks, embeddings, vectors, and inverted index ───────────────────
    onProgress("Migrating chunks, embeddings and vectors...", `${filePaths.length} files`);

    const seenContentHashes = new Set<string>();
    const invertedIndexEntries: Array<{ chunkId: string; content: string }> = [];

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];

      onProgress(
        "Migrating chunks, embeddings and vectors...",
        `${i + 1}/${filePaths.length}: ${path.basename(filePath)}`,
      );

      const chunks = await sourceDb.getChunksByFile(filePath);
      if (chunks.length === 0) continue;

      // Migrate chunk metadata rows.
      await targetDb.upsertChunksBatch(chunks);
      stats.chunkCount += chunks.length;

      // Read file once for inverted-index re-tokenization.
      let fileLines: string[] | null = null;
      if (existsSync(filePath)) {
        try {
          fileLines = readFileSync(filePath, "utf-8").split("\n");
        } catch {
          // File unreadable — skip inverted index for this file.
        }
      }

      const vectorBatch: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }> = [];

      for (const chunk of chunks) {
        // Inverted index: extract the chunk text from the live file.
        if (fileLines) {
          const text = fileLines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
          if (text.trim()) {
            invertedIndexEntries.push({ chunkId: chunk.chunkId, content: text });
          }
        }

        // Each unique content-hash maps to exactly one embedding buffer.
        if (!seenContentHashes.has(chunk.contentHash)) {
          seenContentHashes.add(chunk.contentHash);

          const embBuffer = await sourceDb.getEmbedding(chunk.contentHash);
          if (embBuffer) {
            // Persist the raw BYTEA into pgvector's embedding cache.
            // chunkText / model are not stored in the SQLite interface;
            // passing sentinel values preserves the cache hit without
            // re-embedding while keeping the schema valid.
            await targetDb.upsertEmbedding(chunk.contentHash, embBuffer, "", "migrated");
            stats.embeddingCount++;

            // Convert BYTEA → float32 for the ANN vector column.
            const vector = Array.from(bufferToFloat32Array(embBuffer));
            vectorBatch.push({
              id: chunk.chunkId,
              vector,
              metadata: {
                filePath: chunk.filePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                chunkType: (chunk.nodeType ?? "other") as ChunkMetadata["chunkType"],
                name: chunk.name,
                language: chunk.language,
                hash: chunk.contentHash,
              },
            });
          }
        }
      }

      if (vectorBatch.length > 0) {
        await targetStore.addBatch(vectorBatch);
        stats.vectorCount += vectorBatch.length;
      }
    }

    // ── 3. Inverted index (BM25 posting tables) ──────────────────────────────
    onProgress("Migrating inverted index...", `${invertedIndexEntries.length} chunks`);
    const II_BATCH = 200;
    for (let i = 0; i < invertedIndexEntries.length; i += II_BATCH) {
      await targetDb.upsertInvertedIndexChunkBatch(invertedIndexEntries.slice(i, i + II_BATCH));
    }
    stats.invertedIndexChunkCount = invertedIndexEntries.length;

    // ── 4. Branch chunk catalog ──────────────────────────────────────────────
    onProgress("Migrating branch catalog...");
    const branches = await sourceDb.getAllBranches();
    for (const branch of branches) {
      const chunkIds = await sourceDb.getBranchChunkIds(branch);
      if (chunkIds.length > 0) {
        await targetDb.addChunksToBranchBatch(branch, chunkIds);
      }
    }
    stats.branchCount = branches.length;

    // ── 5. Symbols ───────────────────────────────────────────────────────────
    onProgress("Migrating symbols...");
    for (const filePath of filePaths) {
      const symbols = await sourceDb.getSymbolsByFile(filePath);
      if (symbols.length > 0) {
        await targetDb.upsertSymbolsBatch(symbols);
        stats.symbolCount += symbols.length;
      }
    }

    // Branch symbol catalog.
    for (const branch of branches) {
      const symbolIds = await sourceDb.getBranchSymbolIds(branch);
      if (symbolIds.length > 0) {
        await targetDb.addSymbolsToBranchBatch(branch, symbolIds);
      }
    }

    // ── 6. Call edges ────────────────────────────────────────────────────────
    onProgress("Migrating call edges...");
    // Collect unique symbol IDs across all branches.
    const allSymbolIds = new Set<string>();
    for (const branch of branches) {
      for (const id of await sourceDb.getBranchSymbolIds(branch)) {
        allSymbolIds.add(id);
      }
    }

    const seenEdgeIds = new Set<string>();
    const edgeBatch: import("../db/backend.js").CallEdgeData[] = [];
    const EDGE_BATCH = 500;

    const firstBranch = branches[0] ?? "main";
    for (const symbolId of allSymbolIds) {
      const callees = await sourceDb.getCallees(symbolId, firstBranch);
      for (const edge of callees) {
        if (!seenEdgeIds.has(edge.id)) {
          seenEdgeIds.add(edge.id);
          edgeBatch.push(edge);
          if (edgeBatch.length >= EDGE_BATCH) {
            await targetDb.upsertCallEdgesBatch(edgeBatch);
            stats.callEdgeCount += edgeBatch.length;
            edgeBatch.length = 0;
          }
        }
      }
    }
    if (edgeBatch.length > 0) {
      await targetDb.upsertCallEdgesBatch(edgeBatch);
      stats.callEdgeCount += edgeBatch.length;
    }

    return stats;
  } finally {
    await sourceDb.close();
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function parseMigrateArgs(argv: string[]): {
  project: string;
  deleteSqlite: boolean;
  dryRun: boolean;
} {
  let project = process.cwd();
  let deleteSqlite = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--delete-sqlite") {
      deleteSqlite = true;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { project, deleteSqlite, dryRun };
}

export async function handleMigrateCommand(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(`Usage: opencode-codebase-index migrate [options]

Migrates an existing SQLite index to the pgvector database configured in
codebase-index.json.  The target config must have database.engine = "pgvector".

Options:
  --project <path>   Project root directory (default: current directory)
  --delete-sqlite    Delete SQLite files after a successful migration
  --dry-run          Show what would be migrated without writing to pgvector
  -h, --help         Show this help message`);
    return;
  }

  const { project, deleteSqlite, dryRun } = parseMigrateArgs(argv);
  const rawConfig = loadMergedConfig(project);
  const config = parseConfig(rawConfig);

  console.error(`Project root: ${project}`);

  if (config.database.engine !== "pgvector") {
    console.error(
      `Error: database.engine is "${config.database.engine}", not "pgvector".\n` +
      `Set database.engine = "pgvector" in your codebase-index.json before migrating.`,
    );
    process.exit(1);
  }

  const indexPath = resolveProjectIndexPath(project, config.scope);
  const sqliteDbPath = path.join(indexPath, "codebase.db");

  if (!existsSync(sqliteDbPath)) {
    console.error(`No SQLite database found at ${sqliteDbPath}`);
    console.error("Nothing to migrate.");
    return;
  }

  const pg = config.database.pgvector!;
  const connDesc = pg.connectionString
    ? "connection string"
    : `${pg.user ?? "postgres"}@${pg.host ?? "localhost"}:${pg.port ?? 5432}/${pg.database ?? "postgres"}`;
  console.error(`Source : SQLite at ${sqliteDbPath}`);
  console.error(`Target : pgvector (${connDesc})`);
  console.error("");

  if (dryRun) {
    console.error("Dry-run mode — no data will be written to pgvector.");
    // Count what would be migrated.
    const srcDb = new SqliteDatabaseBackend(sqliteDbPath);
    await srcDb.initialize();
    try {
      const hashes = await srcDb.getAllFileHashes();
      const fileCount = [...hashes.keys()].filter((k) => !k.includes("::")).length;
      const branches = await srcDb.getAllBranches();
      console.log(`Would migrate: ${fileCount} files, ${branches.length} branches`);
    } finally {
      await srcDb.close();
    }
    return;
  }

  // Need dimensions from the embedding provider config.
  // Use a minimal provider check — just enough to get dimensions.
  const dimensions = await (async () => {
    const { createCustomProviderInfo, tryDetectProvider, detectEmbeddingProvider } = await import("../embeddings/detector.js");
    if (config.embeddingProvider === "custom") {
      if (!config.customProvider) throw new Error("embeddingProvider is 'custom' but customProvider is missing.");
      return createCustomProviderInfo(config.customProvider).modelInfo.dimensions;
    }
    if (config.embeddingProvider === "auto") {
      return (await tryDetectProvider()).modelInfo.dimensions;
    }
    return (await detectEmbeddingProvider(config.embeddingProvider, config.embeddingModel)).modelInfo.dimensions;
  })();

  console.error(`Embedding dimensions: ${dimensions}`);
  console.error("Connecting to pgvector...");

  const targetDb = await createDatabaseBackend(config.database, "");
  const targetStore = await createVectorStoreBackend(config.database, "", dimensions);

  console.error("Connected. Starting migration...");
  console.error("");

  let lastStep = "";
  const onProgress = (step: string, detail?: string): void => {
    if (step !== lastStep) {
      lastStep = step;
      process.stderr.write(`  ${step}\n`);
    }
    if (detail) {
      process.stderr.write(`    ${detail}\r`);
    }
  };

  try {
    const stats = await runMigration(indexPath, targetDb, targetStore, onProgress);

    console.error("\n");
    console.error("Migration complete:");
    console.error(`  File hashes   : ${stats.fileHashCount}`);
    console.error(`  Chunks        : ${stats.chunkCount}`);
    console.error(`  Embeddings    : ${stats.embeddingCount}`);
    console.error(`  Vectors       : ${stats.vectorCount}`);
    console.error(`  Branches      : ${stats.branchCount}`);
    console.error(`  Symbols       : ${stats.symbolCount}`);
    console.error(`  Call edges    : ${stats.callEdgeCount}`);
    console.error(`  Inverted index: ${stats.invertedIndexChunkCount} chunks`);

    if (deleteSqlite) {
      const { promises: fs } = await import("fs");
      const toDelete = [
        sqliteDbPath,
        `${sqliteDbPath}-shm`,
        `${sqliteDbPath}-wal`,
        path.join(indexPath, "vectors.usearch"),
        path.join(indexPath, "file-hashes.json"),
        path.join(indexPath, "inverted-index.json"),
      ];
      console.error("\nDeleting SQLite files...");
      for (const f of toDelete) {
        try {
          await fs.rm(f, { force: true });
          console.error(`  Deleted: ${f}`);
        } catch {
          // best-effort
        }
      }
    }
  } finally {
    await targetDb.close();
    // PgVectorStoreBackend has a close() not on the interface — call it if present.
    const storeWithClose = targetStore as unknown as { close?: () => Promise<void> };
    if (typeof storeWithClose.close === "function") {
      await storeWithClose.close();
    }
  }
}
