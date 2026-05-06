/**
 * Abstract async interfaces for the database and vector-store backends.
 *
 * Both the SQLite (local) backend and the pgvector (remote) backend implement
 * these interfaces.  All methods return Promises so that the pgvector backend
 * can perform network I/O without blocking the Node.js event loop.  The SQLite
 * backend wraps the synchronous native calls in Promise.resolve() with zero
 * overhead.
 */

import type { ChunkData, BranchDelta, DatabaseStats, SymbolData, CallEdgeData, ChunkMetadata } from "../native/index.js";

// Re-export so callers can import from a single location.
export type { ChunkData, BranchDelta, DatabaseStats, SymbolData, CallEdgeData, ChunkMetadata };

// ── Vector-store result type ────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

// ── IVectorStoreBackend ─────────────────────────────────────────────────────

/**
 * Async abstraction over a vector similarity-search store.
 *
 * For SQLite: backed by the native usearch index persisted as a local file.
 * For pgvector: backed by a PostgreSQL table with a `vector` column.
 */
export interface IVectorStoreBackend {
  /**
   * Initialize (or validate) the store for the given embedding dimension.
   * Called once per `Indexer.initialize()`.
   */
  initialize(dimensions: number): Promise<void>;

  /** Load persisted state from disk / remote.  No-op for pgvector. */
  load(): Promise<void>;

  /** Persist in-memory state to disk / remote.  No-op for pgvector. */
  save(): Promise<void>;

  add(id: string, vector: number[], metadata: ChunkMetadata): Promise<void>;

  addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>
  ): Promise<void>;

  search(queryVector: number[], limit: number): Promise<VectorSearchResult[]>;

  remove(id: string): Promise<boolean>;

  count(): Promise<number>;

  clear(): Promise<void>;

  getDimensions(): number;

  getAllKeys(): Promise<string[]>;

  getAllMetadata(): Promise<Array<{ key: string; metadata: ChunkMetadata }>>;

  getMetadata(id: string): Promise<ChunkMetadata | undefined>;

  getMetadataBatch(ids: string[]): Promise<Map<string, ChunkMetadata>>;
}

// ── IDatabaseBackend ────────────────────────────────────────────────────────

/**
 * Async abstraction over the relational metadata + embedding store.
 *
 * For SQLite: backed by the native rusqlite bindings.
 * For pgvector: backed by a PostgreSQL connection pool.
 */
export interface IDatabaseBackend {
  /**
   * Initialize the database schema (run migrations, create tables, etc.).
   * Called once per `Indexer.initialize()`.
   */
  initialize(): Promise<void>;

  /** Close any open connections / file handles. */
  close(): Promise<void>;

  // ── Embeddings ──────────────────────────────────────────────────

  embeddingExists(contentHash: string): Promise<boolean>;

  getEmbedding(contentHash: string): Promise<Buffer | null>;

  upsertEmbedding(
    contentHash: string,
    embedding: Buffer,
    chunkText: string,
    model: string
  ): Promise<void>;

  upsertEmbeddingsBatch(
    items: Array<{
      contentHash: string;
      embedding: Buffer;
      chunkText: string;
      model: string;
    }>
  ): Promise<void>;

  getMissingEmbeddings(contentHashes: string[]): Promise<string[]>;

  // ── Chunks ──────────────────────────────────────────────────────

  upsertChunk(chunk: ChunkData): Promise<void>;

  upsertChunksBatch(chunks: ChunkData[]): Promise<void>;

  getChunk(chunkId: string): Promise<ChunkData | null>;

  getChunksByFile(filePath: string): Promise<ChunkData[]>;

  getChunksByName(name: string): Promise<ChunkData[]>;

  getChunksByNameCi(name: string): Promise<ChunkData[]>;

  deleteChunksByFile(filePath: string): Promise<number>;

  // ── Branch catalog ───────────────────────────────────────────────

  addChunksToBranch(branch: string, chunkIds: string[]): Promise<void>;

  addChunksToBranchBatch(branch: string, chunkIds: string[]): Promise<void>;

  clearBranch(branch: string): Promise<number>;

  deleteBranchChunksByChunkIds(chunkIds: string[]): Promise<number>;

  deleteBranchChunksForBranch(branch: string, chunkIds: string[]): Promise<number>;

  getBranchChunkIds(branch: string): Promise<string[]>;

  getBranchDelta(branch: string, baseBranch: string): Promise<BranchDelta>;

  getReferencedChunkIds(chunkIds: string[]): Promise<string[]>;

  chunkExistsOnBranch(branch: string, chunkId: string): Promise<boolean>;

  getAllBranches(): Promise<string[]>;

  // ── Metadata key-value store ─────────────────────────────────────

  getMetadata(key: string): Promise<string | null>;

  setMetadata(key: string, value: string): Promise<void>;

  deleteMetadata(key: string): Promise<boolean>;

  // ── Maintenance ─────────────────────────────────────────────────

  clearAllIndexedData(): Promise<void>;

  clearCallEdgeTargetsForSymbols(symbolIds: string[]): Promise<number>;

  gcOrphanEmbeddings(): Promise<number>;

  gcOrphanChunks(): Promise<number>;

  getStats(): Promise<DatabaseStats>;

  // ── Symbols ─────────────────────────────────────────────────────

  upsertSymbol(symbol: SymbolData): Promise<void>;

  upsertSymbolsBatch(symbols: SymbolData[]): Promise<void>;

  getSymbolsByFile(filePath: string): Promise<SymbolData[]>;

  getSymbolByName(name: string, filePath: string): Promise<SymbolData | null>;

  getSymbolsByName(name: string): Promise<SymbolData[]>;

  getSymbolsByNameCi(name: string): Promise<SymbolData[]>;

  deleteSymbolsByFile(filePath: string): Promise<number>;

  // ── Call edges ───────────────────────────────────────────────────

  upsertCallEdge(edge: CallEdgeData): Promise<void>;

  upsertCallEdgesBatch(edges: CallEdgeData[]): Promise<void>;

  getCallers(targetName: string, branch: string): Promise<CallEdgeData[]>;

  getCallersWithContext(targetName: string, branch: string): Promise<CallEdgeData[]>;

  getCallees(symbolId: string, branch: string): Promise<CallEdgeData[]>;

  deleteCallEdgesByFile(filePath: string): Promise<number>;

  resolveCallEdge(edgeId: string, toSymbolId: string): Promise<void>;

  // ── Branch symbols ───────────────────────────────────────────────

  addSymbolsToBranch(branch: string, symbolIds: string[]): Promise<void>;

  addSymbolsToBranchBatch(branch: string, symbolIds: string[]): Promise<void>;

  getBranchSymbolIds(branch: string): Promise<string[]>;

  clearBranchSymbols(branch: string): Promise<number>;

  getReferencedSymbolIds(symbolIds: string[]): Promise<string[]>;

  deleteBranchSymbolsBySymbolIds(symbolIds: string[]): Promise<number>;

  deleteBranchSymbolsForBranch(branch: string, symbolIds: string[]): Promise<number>;

  // ── GC for symbols / edges ───────────────────────────────────────

  gcOrphanSymbols(): Promise<number>;

  gcOrphanCallEdges(): Promise<number>;

  // ── File hashes ──────────────────────────────────────────────────

  getFileHash(filePath: string): Promise<string | null>;

  setFileHash(filePath: string, hash: string): Promise<void>;

  deleteFileHash(filePath: string): Promise<void>;

  getAllFileHashes(): Promise<Map<string, string>>;

  setFileHashesBatch(hashes: Map<string, string>): Promise<void>;

  deleteFileHashesBatch(filePaths: string[]): Promise<void>;

  /** Atomically replace the entire file-hash store with the given map. */
  replaceAllFileHashes(hashes: Map<string, string>): Promise<void>;

  /** Fetch stored hashes for only the given paths (avoids a full table load). */
  getFileHashBatch(filePaths: string[]): Promise<Map<string, string>>;

  /** True if the store contains any path not under any of the given roots. */
  hasFileHashesOutsideRoots(roots: string[]): Promise<boolean>;

  /** All stored paths that fall under at least one of the given roots. */
  getFilePathsInRoots(roots: string[]): Promise<string[]>;

  /** Delete every hash record whose path is under any of the given roots. */
  deleteFileHashesInRoots(roots: string[]): Promise<void>;

  // ── Inverted index ───────────────────────────────────────────────

  saveInvertedIndex(json: string): Promise<void>;

  loadInvertedIndex(): Promise<string | null>;

  /**
   * BM25 keyword search against the persisted inverted index.
   * Returns null for SQLite (caller uses the in-memory Rust struct instead).
   * pgvector returns scored results directly from the DB.
   */
  searchBm25(query: string, limit: number): Promise<Map<string, number> | null>;

  // ── Indexing lock ────────────────────────────────────────────────

  tryAcquireLock(pid: number, startedAt: string): Promise<boolean>;

  releaseLock(): Promise<void>;

  isLocked(): Promise<boolean>;
}
