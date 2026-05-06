/**
 * SQLite implementations of IDatabaseBackend and IVectorStoreBackend.
 *
 * These are thin synchronous wrappers around the existing native Rust/NAPI
 * classes.  Every method returns Promise.resolve() so the async interface is
 * satisfied with zero overhead.
 */

import * as path from "path";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";

function isPathUnderRoot(filePath: string, root: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(filePath);
  return f === r || f.startsWith(r + path.sep);
}
import { promises as fsPromises } from "fs";
import type {
  IDatabaseBackend,
  IVectorStoreBackend,
  VectorSearchResult,
} from "./backend.js";
import type { ChunkData, BranchDelta, DatabaseStats, SymbolData, CallEdgeData, ChunkMetadata } from "./backend.js";
import { Database, VectorStore, InvertedIndex } from "../native/index.js";

// ── SqliteVectorStoreBackend ────────────────────────────────────────────────

export class SqliteVectorStoreBackend implements IVectorStoreBackend {
  private inner: VectorStore | null = null;
  private dimensions = 0;
  private readonly storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  async initialize(dimensions: number): Promise<void> {
    this.dimensions = dimensions;
    this.inner = new VectorStore(this.storePath, dimensions);
  }

  async load(): Promise<void> {
    const indexFile = `${this.storePath}.usearch`;
    if (existsSync(indexFile)) {
      this.inner!.load();
    }
  }

  async save(): Promise<void> {
    this.inner!.save();
  }

  async add(id: string, vector: number[], metadata: ChunkMetadata): Promise<void> {
    this.inner!.add(id, vector, metadata);
  }

  async addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>
  ): Promise<void> {
    this.inner!.addBatch(items);
  }

  async search(queryVector: number[], limit: number): Promise<VectorSearchResult[]> {
    return this.inner!.search(queryVector, limit);
  }

  async remove(id: string): Promise<boolean> {
    return this.inner!.remove(id);
  }

  async count(): Promise<number> {
    return this.inner!.count();
  }

  async clear(): Promise<void> {
    this.inner!.clear();
  }

  getDimensions(): number {
    return this.dimensions;
  }

  async getAllKeys(): Promise<string[]> {
    return this.inner!.getAllKeys();
  }

  async getAllMetadata(): Promise<Array<{ key: string; metadata: ChunkMetadata }>> {
    return this.inner!.getAllMetadata();
  }

  async getMetadata(id: string): Promise<ChunkMetadata | undefined> {
    return this.inner!.getMetadata(id);
  }

  async getMetadataBatch(ids: string[]): Promise<Map<string, ChunkMetadata>> {
    return this.inner!.getMetadataBatch(ids);
  }

  /** Expose the underlying InvertedIndex path for callers that still need the
   *  native InvertedIndex (always local for both backends). */
  getStorePath(): string {
    return this.storePath;
  }
}

// ── SqliteDatabaseBackend ───────────────────────────────────────────────────

export class SqliteDatabaseBackend implements IDatabaseBackend {
  private inner: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    this.inner = new Database(this.dbPath);
  }

  async close(): Promise<void> {
    this.inner?.close();
    this.inner = null;
  }

  /** Expose path so the Indexer can check for file existence and corruption. */
  getDbPath(): string {
    return this.dbPath;
  }

  /** Whether the DB file already existed before initialize() was called. */
  async dbFileExists(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  /** Delete all SQLite-related files (used on corruption reset). */
  async deleteFiles(): Promise<void> {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        await fsPromises.rm(this.dbPath + suffix, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  // ── Embeddings ──────────────────────────────────────────────────

  async embeddingExists(contentHash: string): Promise<boolean> {
    return this.inner!.embeddingExists(contentHash);
  }

  async getEmbedding(contentHash: string): Promise<Buffer | null> {
    return this.inner!.getEmbedding(contentHash);
  }

  async upsertEmbedding(
    contentHash: string,
    embedding: Buffer,
    chunkText: string,
    model: string
  ): Promise<void> {
    this.inner!.upsertEmbedding(contentHash, embedding, chunkText, model);
  }

  async upsertEmbeddingsBatch(
    items: Array<{ contentHash: string; embedding: Buffer; chunkText: string; model: string }>
  ): Promise<void> {
    this.inner!.upsertEmbeddingsBatch(items);
  }

  async getMissingEmbeddings(contentHashes: string[]): Promise<string[]> {
    return this.inner!.getMissingEmbeddings(contentHashes);
  }

  // ── Chunks ──────────────────────────────────────────────────────

  async upsertChunk(chunk: ChunkData): Promise<void> {
    this.inner!.upsertChunk(chunk);
  }

  async upsertChunksBatch(chunks: ChunkData[]): Promise<void> {
    this.inner!.upsertChunksBatch(chunks);
  }

  async getChunk(chunkId: string): Promise<ChunkData | null> {
    return this.inner!.getChunk(chunkId);
  }

  async getChunksByFile(filePath: string): Promise<ChunkData[]> {
    return this.inner!.getChunksByFile(filePath);
  }

  async getChunksByName(name: string): Promise<ChunkData[]> {
    return this.inner!.getChunksByName(name);
  }

  async getChunksByNameCi(name: string): Promise<ChunkData[]> {
    return this.inner!.getChunksByNameCi(name);
  }

  async deleteChunksByFile(filePath: string): Promise<number> {
    return this.inner!.deleteChunksByFile(filePath);
  }

  // ── Branch catalog ───────────────────────────────────────────────

  async addChunksToBranch(branch: string, chunkIds: string[]): Promise<void> {
    this.inner!.addChunksToBranch(branch, chunkIds);
  }

  async addChunksToBranchBatch(branch: string, chunkIds: string[]): Promise<void> {
    this.inner!.addChunksToBranchBatch(branch, chunkIds);
  }

  async clearBranch(branch: string): Promise<number> {
    return this.inner!.clearBranch(branch);
  }

  async deleteBranchChunksByChunkIds(chunkIds: string[]): Promise<number> {
    return this.inner!.deleteBranchChunksByChunkIds(chunkIds);
  }

  async deleteBranchChunksForBranch(branch: string, chunkIds: string[]): Promise<number> {
    return this.inner!.deleteBranchChunksForBranch(branch, chunkIds);
  }

  async getBranchChunkIds(branch: string): Promise<string[]> {
    return this.inner!.getBranchChunkIds(branch);
  }

  async getBranchDelta(branch: string, baseBranch: string): Promise<BranchDelta> {
    return this.inner!.getBranchDelta(branch, baseBranch);
  }

  async getReferencedChunkIds(chunkIds: string[]): Promise<string[]> {
    return this.inner!.getReferencedChunkIds(chunkIds);
  }

  async chunkExistsOnBranch(branch: string, chunkId: string): Promise<boolean> {
    return this.inner!.chunkExistsOnBranch(branch, chunkId);
  }

  async getAllBranches(): Promise<string[]> {
    return this.inner!.getAllBranches();
  }

  // ── Metadata ─────────────────────────────────────────────────────

  async getMetadata(key: string): Promise<string | null> {
    return this.inner!.getMetadata(key);
  }

  async setMetadata(key: string, value: string): Promise<void> {
    this.inner!.setMetadata(key, value);
  }

  async deleteMetadata(key: string): Promise<boolean> {
    return this.inner!.deleteMetadata(key);
  }

  // ── Maintenance ──────────────────────────────────────────────────

  async clearAllIndexedData(): Promise<void> {
    this.inner!.clearAllIndexedData();
  }

  async clearCallEdgeTargetsForSymbols(symbolIds: string[]): Promise<number> {
    return this.inner!.clearCallEdgeTargetsForSymbols(symbolIds);
  }

  async gcOrphanEmbeddings(): Promise<number> {
    return this.inner!.gcOrphanEmbeddings();
  }

  async gcOrphanChunks(): Promise<number> {
    return this.inner!.gcOrphanChunks();
  }

  async getStats(): Promise<DatabaseStats> {
    return this.inner!.getStats();
  }

  // ── Symbols ──────────────────────────────────────────────────────

  async upsertSymbol(symbol: SymbolData): Promise<void> {
    this.inner!.upsertSymbol(symbol);
  }

  async upsertSymbolsBatch(symbols: SymbolData[]): Promise<void> {
    this.inner!.upsertSymbolsBatch(symbols);
  }

  async getSymbolsByFile(filePath: string): Promise<SymbolData[]> {
    return this.inner!.getSymbolsByFile(filePath);
  }

  async getSymbolByName(name: string, filePath: string): Promise<SymbolData | null> {
    return this.inner!.getSymbolByName(name, filePath);
  }

  async getSymbolsByName(name: string): Promise<SymbolData[]> {
    return this.inner!.getSymbolsByName(name);
  }

  async getSymbolsByNameCi(name: string): Promise<SymbolData[]> {
    return this.inner!.getSymbolsByNameCi(name);
  }

  async deleteSymbolsByFile(filePath: string): Promise<number> {
    return this.inner!.deleteSymbolsByFile(filePath);
  }

  // ── Call edges ────────────────────────────────────────────────────

  async upsertCallEdge(edge: CallEdgeData): Promise<void> {
    this.inner!.upsertCallEdge(edge);
  }

  async upsertCallEdgesBatch(edges: CallEdgeData[]): Promise<void> {
    this.inner!.upsertCallEdgesBatch(edges);
  }

  async getCallers(targetName: string, branch: string): Promise<CallEdgeData[]> {
    return this.inner!.getCallers(targetName, branch);
  }

  async getCallersWithContext(targetName: string, branch: string): Promise<CallEdgeData[]> {
    return this.inner!.getCallersWithContext(targetName, branch);
  }

  async getCallees(symbolId: string, branch: string): Promise<CallEdgeData[]> {
    return this.inner!.getCallees(symbolId, branch);
  }

  async deleteCallEdgesByFile(filePath: string): Promise<number> {
    return this.inner!.deleteCallEdgesByFile(filePath);
  }

  async resolveCallEdge(edgeId: string, toSymbolId: string): Promise<void> {
    this.inner!.resolveCallEdge(edgeId, toSymbolId);
  }

  // ── Branch symbols ────────────────────────────────────────────────

  async addSymbolsToBranch(branch: string, symbolIds: string[]): Promise<void> {
    this.inner!.addSymbolsToBranch(branch, symbolIds);
  }

  async addSymbolsToBranchBatch(branch: string, symbolIds: string[]): Promise<void> {
    this.inner!.addSymbolsToBranchBatch(branch, symbolIds);
  }

  async getBranchSymbolIds(branch: string): Promise<string[]> {
    return this.inner!.getBranchSymbolIds(branch);
  }

  async clearBranchSymbols(branch: string): Promise<number> {
    return this.inner!.clearBranchSymbols(branch);
  }

  async getReferencedSymbolIds(symbolIds: string[]): Promise<string[]> {
    return this.inner!.getReferencedSymbolIds(symbolIds);
  }

  async deleteBranchSymbolsBySymbolIds(symbolIds: string[]): Promise<number> {
    return this.inner!.deleteBranchSymbolsBySymbolIds(symbolIds);
  }

  async deleteBranchSymbolsForBranch(branch: string, symbolIds: string[]): Promise<number> {
    return this.inner!.deleteBranchSymbolsForBranch(branch, symbolIds);
  }

  // ── GC ───────────────────────────────────────────────────────────

  async gcOrphanSymbols(): Promise<number> {
    return this.inner!.gcOrphanSymbols();
  }

  async gcOrphanCallEdges(): Promise<number> {
    return this.inner!.gcOrphanCallEdges();
  }

  // ── File hashes (file-hashes.json) ───────────────────────────────

  private fileHashesPath(): string {
    return path.join(path.dirname(this.dbPath), "file-hashes.json");
  }

  private invertedIndexFilePath(): string {
    return path.join(path.dirname(this.dbPath), "inverted-index.json");
  }

  private lockFilePath(): string {
    return path.join(path.dirname(this.dbPath), "indexing.lock");
  }

  private readFileHashesFromDisk(): Map<string, string> {
    const p = this.fileHashesPath();
    if (!existsSync(p)) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(p, "utf-8"))));
    } catch {
      return new Map();
    }
  }

  private atomicWriteSync(targetPath: string, data: string): void {
    const tempPath = `${targetPath}.tmp`;
    writeFileSync(tempPath, data);
    renameSync(tempPath, targetPath);
  }

  private writeFileHashesToDisk(hashes: Map<string, string>): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of hashes) obj[k] = v;
    this.atomicWriteSync(this.fileHashesPath(), JSON.stringify(obj));
  }

  async getFileHash(filePath: string): Promise<string | null> {
    return this.readFileHashesFromDisk().get(filePath) ?? null;
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    const hashes = this.readFileHashesFromDisk();
    hashes.set(filePath, hash);
    this.writeFileHashesToDisk(hashes);
  }

  async deleteFileHash(filePath: string): Promise<void> {
    const hashes = this.readFileHashesFromDisk();
    hashes.delete(filePath);
    this.writeFileHashesToDisk(hashes);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    return this.readFileHashesFromDisk();
  }

  async setFileHashesBatch(hashes: Map<string, string>): Promise<void> {
    const existing = this.readFileHashesFromDisk();
    for (const [k, v] of hashes) existing.set(k, v);
    this.writeFileHashesToDisk(existing);
  }

  async deleteFileHashesBatch(filePaths: string[]): Promise<void> {
    const hashes = this.readFileHashesFromDisk();
    for (const p of filePaths) hashes.delete(p);
    this.writeFileHashesToDisk(hashes);
  }

  async replaceAllFileHashes(hashes: Map<string, string>): Promise<void> {
    this.writeFileHashesToDisk(hashes);
  }

  async getFileHashBatch(filePaths: string[]): Promise<Map<string, string>> {
    if (filePaths.length === 0) return new Map();
    const all = this.readFileHashesFromDisk();
    const result = new Map<string, string>();
    for (const fp of filePaths) {
      const h = all.get(fp);
      if (h !== undefined) result.set(fp, h);
    }
    return result;
  }

  async hasFileHashesOutsideRoots(roots: string[]): Promise<boolean> {
    if (roots.length === 0) return false;
    const all = this.readFileHashesFromDisk();
    for (const fp of all.keys()) {
      if (!roots.some((r) => isPathUnderRoot(fp, r))) return true;
    }
    return false;
  }

  async getFilePathsInRoots(roots: string[]): Promise<string[]> {
    if (roots.length === 0) return [];
    const all = this.readFileHashesFromDisk();
    return Array.from(all.keys()).filter((fp) => roots.some((r) => isPathUnderRoot(fp, r)));
  }

  async deleteFileHashesInRoots(roots: string[]): Promise<void> {
    if (roots.length === 0) return;
    const hashes = this.readFileHashesFromDisk();
    for (const fp of Array.from(hashes.keys())) {
      if (roots.some((r) => isPathUnderRoot(fp, r))) hashes.delete(fp);
    }
    this.writeFileHashesToDisk(hashes);
  }

  // ── Inverted index (inverted-index.json) ──────────────────────────

  async saveInvertedIndex(json: string): Promise<void> {
    this.atomicWriteSync(this.invertedIndexFilePath(), json);
  }

  async loadInvertedIndex(): Promise<string | null> {
    const p = this.invertedIndexFilePath();
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  }

  // ── Indexing lock (indexing.lock) ─────────────────────────────────

  async tryAcquireLock(pid: number, startedAt: string): Promise<boolean> {
    const lockPath = this.lockFilePath();
    if (existsSync(lockPath)) return false;
    writeFileSync(lockPath, JSON.stringify({ pid, startedAt }));
    return true;
  }

  async releaseLock(): Promise<void> {
    const lockPath = this.lockFilePath();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }

  async isLocked(): Promise<boolean> {
    return existsSync(this.lockFilePath());
  }

  // ── Inverted index search (handled by in-memory Rust struct for SQLite) ──

  async searchBm25(_query: string, _limit: number): Promise<Map<string, number> | null> {
    return null; // caller falls back to this.invertedIndex.search()
  }
}

// ── Helpers exported for Indexer use ─────────────────────────────────────────

/**
 * Create and wire up the native InvertedIndex at the given path.
 * This is always local for both backends.
 */
export function createLocalInvertedIndex(indexPath: string): InvertedIndex {
  return new InvertedIndex(path.join(path.dirname(indexPath), "inverted-index.json"));
}
