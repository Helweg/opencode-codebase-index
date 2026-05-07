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

  add(id: string, vector: number[], metadata: ChunkMetadata, sourceId?: string): Promise<void>;

  addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>,
    sourceId?: string
  ): Promise<void>;

  /**
   * Search for nearest neighbours.
   * @param sourceIds  When provided, restrict results to chunks belonging to
   *                   these sources.  Ignored by the SQLite backend (single-
   *                   project files have no cross-source ambiguity).
   */
  search(queryVector: number[], limit: number, sourceIds?: string[]): Promise<VectorSearchResult[]>;

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

  /**
   * Whether this backend supports per-source isolation via source IDs.
   * pgvector returns true; SQLite returns false (single-project-per-file,
   * isolation is handled by the projectHash:branch catalog key instead).
   */
  supportsSourceIsolation(): boolean;

  /**
   * Register or retrieve a source (project root or knowledge-base root).
   * Returns a stable source ID (hash of rootPath) that is used to tag all
   * data written by that source.
   * No-op on SQLite (returns hash of rootPath without persisting).
   */
  getOrCreateSource(rootPath: string): Promise<string>;

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

  /** @param sourceId  Ignored by SQLite (no Rust-layer column yet). Defaults to '' when omitted. */
  upsertChunksBatch(chunks: ChunkData[], sourceId?: string): Promise<void>;

  getChunk(chunkId: string): Promise<ChunkData | null>;

  /** @param sourceId  Ignored by SQLite. Omit to return chunks from all sources. */
  getChunksByFile(filePath: string, sourceId?: string): Promise<ChunkData[]>;

  getChunksByName(name: string): Promise<ChunkData[]>;

  getChunksByNameCi(name: string): Promise<ChunkData[]>;

  /** @param sourceId  Ignored by SQLite. Omit to delete across all sources. */
  deleteChunksByFile(filePath: string, sourceId?: string): Promise<number>;

  /**
   * All distinct file paths that have at least one chunk stored.
   * @param sourceId  Scoped to this source. Ignored by SQLite (returns all paths). Omit for all sources.
   */
  getChunkFilePaths(sourceId?: string): Promise<string[]>;

  /** Return all distinct file paths stored in chunks that fall under at least one of the given root directories. */
  getFilePathsInRoots(roots: string[]): Promise<string[]>;


  // ── Branch catalog ───────────────────────────────────────────────

  addChunksToBranch(branch: string, chunkIds: string[]): Promise<void>;

  /** @param sourceId  Ignored by SQLite (branch key encodes project identity). Defaults to '' when omitted. */
  addChunksToBranchBatch(branch: string, chunkIds: string[], sourceId?: string): Promise<void>;

  /** @param sourceId  Ignored by SQLite. Omit to clear across all sources. */
  clearBranch(branch: string, sourceId?: string): Promise<number>;

  deleteBranchChunksByChunkIds(chunkIds: string[]): Promise<number>;

  deleteBranchChunksForBranch(branch: string, chunkIds: string[]): Promise<number>;

  /**
   * IDs of chunks on this branch, optionally restricted to given sources.
   * @param sourceIds  Ignored by SQLite.
   */
  getBranchChunkIds(branch: string, sourceIds?: string[]): Promise<string[]>;

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

  /** @param sourceId  Ignored by SQLite. Defaults to '' when omitted. */
  upsertSymbolsBatch(symbols: SymbolData[], sourceId?: string): Promise<void>;

  /** @param sourceId  Ignored by SQLite. Omit to return symbols from all sources. */
  getSymbolsByFile(filePath: string, sourceId?: string): Promise<SymbolData[]>;

  getSymbolByName(name: string, filePath: string): Promise<SymbolData | null>;

  getSymbolsByName(name: string): Promise<SymbolData[]>;

  getSymbolsByNameCi(name: string): Promise<SymbolData[]>;

  /** @param sourceId  Ignored by SQLite. Omit to delete across all sources. */
  deleteSymbolsByFile(filePath: string, sourceId?: string): Promise<number>;

  // ── Call edges ───────────────────────────────────────────────────

  upsertCallEdge(edge: CallEdgeData): Promise<void>;

  /** @param sourceId  Ignored by SQLite. Defaults to '' when omitted. */
  upsertCallEdgesBatch(edges: CallEdgeData[], sourceId?: string): Promise<void>;

  /** @param sourceIds  Ignored by SQLite. */
  getCallers(targetName: string, branch: string, sourceIds?: string[]): Promise<CallEdgeData[]>;

  /** @param sourceIds  Ignored by SQLite. */
  getCallersWithContext(targetName: string, branch: string, sourceIds?: string[]): Promise<CallEdgeData[]>;

  /** @param sourceIds  Ignored by SQLite. */
  getCallees(symbolId: string, branch: string, sourceIds?: string[]): Promise<CallEdgeData[]>;

  /** @param sourceId  Ignored by SQLite. Omit to delete across all sources. */
  deleteCallEdgesByFile(filePath: string, sourceId?: string): Promise<number>;

  resolveCallEdge(edgeId: string, toSymbolId: string): Promise<void>;

  // ── Branch symbols ───────────────────────────────────────────────

  addSymbolsToBranch(branch: string, symbolIds: string[]): Promise<void>;

  /** @param sourceId  Ignored by SQLite. Defaults to '' when omitted. */
  addSymbolsToBranchBatch(branch: string, symbolIds: string[], sourceId?: string): Promise<void>;

  /**
   * @param sourceIds  Ignored by SQLite.
   */
  getBranchSymbolIds(branch: string, sourceIds?: string[]): Promise<string[]>;

  /** @param sourceId  Ignored by SQLite. Omit to clear across all sources. */
  clearBranchSymbols(branch: string, sourceId?: string): Promise<number>;

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

  /** @param sourceId  Scopes the batch to this source. Defaults to '' when omitted. */
  setFileHashesBatch(hashes: Map<string, string>, sourceId?: string): Promise<void>;

  deleteFileHashesBatch(filePaths: string[]): Promise<void>;

  /**
   * Atomically replace the file-hash store for one source.
   * @param sourceId  Scopes the replacement to this source only. Defaults to '' when omitted.
   */
  replaceAllFileHashes(hashes: Map<string, string>, sourceId?: string): Promise<void>;

  /** Fetch stored hashes for the given paths scoped to one source. Defaults to '' when omitted. */
  getFileHashBatch(filePaths: string[], sourceId?: string): Promise<Map<string, string>>;

  /**
   * True if there are file hashes belonging to sources other than those listed.
   * Used to detect foreign data in a shared DB.  SQLite always returns false.
   */
  hasSourcesOtherThan(sourceIds: string[]): Promise<boolean>;

  /** All stored file paths for the given source. */
  getFilePathsBySource(sourceId: string): Promise<string[]>;

  /** Delete all file hash records for the given source. */
  deleteFileHashesBySource(sourceId: string): Promise<void>;

  // ── Inverted index ───────────────────────────────────────────────

  saveInvertedIndex(json: string): Promise<void>;

  loadInvertedIndex(): Promise<string | null>;

  /**
   * Incrementally upsert posting data for a batch of chunks.
   * For pgvector: writes directly to the posting tables.
   * For SQLite: no-op (in-memory Rust struct is authoritative).
   */
  upsertInvertedIndexChunkBatch(entries: Array<{ chunkId: string; content: string }>): Promise<void>;

  /**
   * Remove posting data for a batch of chunk IDs.
   * For pgvector: deletes from posting and doc_lengths tables.
   * For SQLite: no-op.
   */
  deleteInvertedIndexChunkBatch(chunkIds: string[]): Promise<void>;

  /**
   * BM25 keyword search against the persisted inverted index.
   * Returns null for SQLite (caller uses the in-memory Rust struct instead).
   * @param sourceIds  Restrict results to these sources.  Ignored by SQLite.
   */
  searchBm25(query: string, limit: number, sourceIds?: string[]): Promise<Map<string, number> | null>;

  // ── Indexing lock ────────────────────────────────────────────────

  tryAcquireLock(pid: number, startedAt: string): Promise<boolean>;

  releaseLock(): Promise<void>;

  isLocked(): Promise<boolean>;

  getLockInfo(): Promise<{ pid: number; startedAt: string } | null>;
}
