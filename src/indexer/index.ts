import { existsSync, readFileSync, writeFileSync, promises as fsPromises } from "fs";
import * as path from "path";
import PQueue from "p-queue";
import pRetry from "p-retry";

import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import { detectEmbeddingProvider, DetectedProvider } from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
} from "../embeddings/provider.js";
import { collectFiles, SkippedFile } from "../utils/files.js";
import { createCostEstimate, CostEstimate } from "../utils/cost.js";
import {
  VectorStore,
  InvertedIndex,
  Database,
  parseFiles,
  createEmbeddingText,
  generateChunkId,
  generateChunkHash,
  ChunkMetadata,
  ChunkData,
  createDynamicBatches,
  hashFile,
} from "../native/index.js";
import { getBranchOrDefault, getBaseBranch, isGitRepo } from "../git/index.js";

function float32ArrayToBuffer(arr: number[]): Buffer {
  const float32 = new Float32Array(arr);
  return Buffer.from(float32.buffer);
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes("429") || message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("too many requests");
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  durationMs: number;
  existingChunks: number;
  removedChunks: number;
  skippedFiles: SkippedFile[];
  parseFailures: string[];
  failedBatchesPath?: string;
}

export interface IndexProgress {
  phase: "scanning" | "parsing" | "embedding" | "storing" | "complete";
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  currentFile?: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

interface PendingChunk {
  id: string;
  text: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

interface FailedBatch {
  chunks: PendingChunk[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

export class Indexer {
  private config: ParsedCodebaseIndexConfig;
  private projectRoot: string;
  private indexPath: string;
  private store: VectorStore | null = null;
  private invertedIndex: InvertedIndex | null = null;
  private database: Database | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private detectedProvider: DetectedProvider | null = null;
  private fileHashCache: Map<string, string> = new Map();
  private fileHashCachePath: string = "";
  private failedBatchesPath: string = "";
  private currentBranch: string = "default";
  private baseBranch: string = "main";

  constructor(projectRoot: string, config: ParsedCodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
    this.fileHashCachePath = path.join(this.indexPath, "file-hashes.json");
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
  }

  private getIndexPath(): string {
    if (this.config.scope === "global") {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      return path.join(homeDir, ".opencode", "global-index");
    }
    return path.join(this.projectRoot, ".opencode", "index");
  }

  private loadFileHashCache(): void {
    try {
      if (existsSync(this.fileHashCachePath)) {
        const data = readFileSync(this.fileHashCachePath, "utf-8");
        const parsed = JSON.parse(data);
        this.fileHashCache = new Map(Object.entries(parsed));
      }
    } catch {
      this.fileHashCache = new Map();
    }
  }

  private saveFileHashCache(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.fileHashCache) {
      obj[k] = v;
    }
    writeFileSync(this.fileHashCachePath, JSON.stringify(obj));
  }

  private loadFailedBatches(): FailedBatch[] {
    try {
      if (existsSync(this.failedBatchesPath)) {
        const data = readFileSync(this.failedBatchesPath, "utf-8");
        return JSON.parse(data) as FailedBatch[];
      }
    } catch {
      return [];
    }
    return [];
  }

  private saveFailedBatches(batches: FailedBatch[]): void {
    if (batches.length === 0) {
      if (existsSync(this.failedBatchesPath)) {
        fsPromises.unlink(this.failedBatchesPath).catch(() => {});
      }
      return;
    }
    writeFileSync(this.failedBatchesPath, JSON.stringify(batches, null, 2));
  }

  private addFailedBatch(batch: PendingChunk[], error: string): void {
    const existing = this.loadFailedBatches();
    existing.push({
      chunks: batch,
      error,
      attemptCount: 1,
      lastAttempt: new Date().toISOString(),
    });
    this.saveFailedBatches(existing);
  }

  async initialize(): Promise<void> {
    this.detectedProvider = await detectEmbeddingProvider(this.config.embeddingProvider);
    if (!this.detectedProvider) {
      throw new Error(
        "No embedding provider available. Configure GitHub, OpenAI, Google, or Ollama."
      );
    }

    this.provider = createEmbeddingProvider(
      this.detectedProvider.credentials,
      this.detectedProvider.modelInfo
    );

    await fsPromises.mkdir(this.indexPath, { recursive: true });

    const dimensions = this.detectedProvider.modelInfo.dimensions;
    const storePath = path.join(this.indexPath, "vectors");
    this.store = new VectorStore(storePath, dimensions);

    const indexFilePath = path.join(this.indexPath, "vectors.usearch");
    if (existsSync(indexFilePath)) {
      this.store.load();
    }

    const invertedIndexPath = path.join(this.indexPath, "inverted-index.json");
    this.invertedIndex = new InvertedIndex(invertedIndexPath);
    try {
      this.invertedIndex.load();
    } catch {
      if (existsSync(invertedIndexPath)) {
        await fsPromises.unlink(invertedIndexPath);
      }
      this.invertedIndex = new InvertedIndex(invertedIndexPath);
    }

    const dbPath = path.join(this.indexPath, "codebase.db");
    const dbIsNew = !existsSync(dbPath);
    this.database = new Database(dbPath);

    if (dbIsNew && this.store.count() > 0) {
      this.migrateFromLegacyIndex();
    }

    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
    }
  }

  private migrateFromLegacyIndex(): void {
    if (!this.store || !this.database) return;

    const allMetadata = this.store.getAllMetadata();
    const chunkIds: string[] = [];

    for (const { key, metadata } of allMetadata) {
      const chunkData: ChunkData = {
        chunkId: key,
        contentHash: metadata.hash,
        filePath: metadata.filePath,
        startLine: metadata.startLine,
        endLine: metadata.endLine,
        nodeType: metadata.chunkType,
        name: metadata.name,
        language: metadata.language,
      };
      this.database.upsertChunk(chunkData);
      chunkIds.push(key);
    }

    this.database.addChunksToBranch(this.currentBranch || "default", chunkIds);
  }

  private async ensureInitialized(): Promise<{
    store: VectorStore;
    provider: EmbeddingProviderInterface;
    invertedIndex: InvertedIndex;
    detectedProvider: DetectedProvider;
    database: Database;
  }> {
    if (!this.store || !this.provider || !this.invertedIndex || !this.detectedProvider || !this.database) {
      await this.initialize();
    }
    return {
      store: this.store!,
      provider: this.provider!,
      invertedIndex: this.invertedIndex!,
      detectedProvider: this.detectedProvider!,
      database: this.database!,
    };
  }

  async estimateCost(): Promise<CostEstimate> {
    const { detectedProvider } = await this.ensureInitialized();

    const { files } = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    return createCostEstimate(files, detectedProvider);
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    const { store, provider, invertedIndex, database, detectedProvider } = await this.ensureInitialized();

    const startTime = Date.now();
    const stats: IndexStats = {
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };

    onProgress?.({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    this.loadFileHashCache();

    const { files, skipped } = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    stats.totalFiles = files.length;
    stats.skippedFiles = skipped;

    const changedFiles: Array<{ path: string; content: string; hash: string }> = [];
    const unchangedFilePaths = new Set<string>();
    const currentFileHashes = new Map<string, string>();

    for (const f of files) {
      const currentHash = hashFile(f.path);
      currentFileHashes.set(f.path, currentHash);
      
      if (this.fileHashCache.get(f.path) === currentHash) {
        unchangedFilePaths.add(f.path);
      } else {
        const content = await fsPromises.readFile(f.path, "utf-8");
        changedFiles.push({ path: f.path, content, hash: currentHash });
      }
    }

    onProgress?.({
      phase: "parsing",
      filesProcessed: 0,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const parsedFiles = parseFiles(changedFiles);
    
    const existingChunks = new Map<string, string>();
    const existingChunksByFile = new Map<string, Set<string>>();
    for (const { key, metadata } of store.getAllMetadata()) {
      existingChunks.set(key, metadata.hash);
      const fileChunks = existingChunksByFile.get(metadata.filePath) || new Set();
      fileChunks.add(key);
      existingChunksByFile.set(metadata.filePath, fileChunks);
    }

    const currentChunkIds = new Set<string>();
    const currentFilePaths = new Set<string>();
    const pendingChunks: PendingChunk[] = [];

    for (const filePath of unchangedFilePaths) {
      currentFilePaths.add(filePath);
      const fileChunks = existingChunksByFile.get(filePath);
      if (fileChunks) {
        for (const chunkId of fileChunks) {
          currentChunkIds.add(chunkId);
        }
      }
    }

    for (const parsed of parsedFiles) {
      currentFilePaths.add(parsed.path);
      
      if (parsed.chunks.length === 0) {
        const relativePath = path.relative(this.projectRoot, parsed.path);
        stats.parseFailures.push(relativePath);
      }
      
      let fileChunkCount = 0;
      for (const chunk of parsed.chunks) {
        if (fileChunkCount >= this.config.indexing.maxChunksPerFile) {
          break;
        }
        
        if (this.config.indexing.semanticOnly && chunk.chunkType === "other") {
          continue;
        }
        
        const id = generateChunkId(parsed.path, chunk);
        const contentHash = generateChunkHash(chunk);
        currentChunkIds.add(id);

        const chunkData: ChunkData = {
          chunkId: id,
          contentHash,
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          nodeType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
        };
        database.upsertChunk(chunkData);

        if (existingChunks.get(id) === contentHash) {
          fileChunkCount++;
          continue;
        }

        const text = createEmbeddingText(chunk, parsed.path);
        const metadata: ChunkMetadata = {
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
          hash: contentHash,
        };

        pendingChunks.push({ id, text, content: chunk.content, contentHash, metadata });
        fileChunkCount++;
      }
    }

    let removedCount = 0;
    for (const [chunkId] of existingChunks) {
      if (!currentChunkIds.has(chunkId)) {
        store.remove(chunkId);
        invertedIndex.removeChunk(chunkId);
        removedCount++;
      }
    }

    stats.totalChunks = pendingChunks.length;
    stats.existingChunks = currentChunkIds.size - pendingChunks.length;
    stats.removedChunks = removedCount;

    if (pendingChunks.length === 0 && removedCount === 0) {
      database.clearBranch(this.currentBranch);
      database.addChunksToBranch(this.currentBranch, Array.from(currentChunkIds));
      this.fileHashCache = currentFileHashes;
      this.saveFileHashCache();
      stats.durationMs = Date.now() - startTime;
      onProgress?.({
        phase: "complete",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      return stats;
    }

    if (pendingChunks.length === 0) {
      database.clearBranch(this.currentBranch);
      database.addChunksToBranch(this.currentBranch, Array.from(currentChunkIds));
      store.save();
      invertedIndex.save();
      this.fileHashCache = currentFileHashes;
      this.saveFileHashCache();
      stats.durationMs = Date.now() - startTime;
      onProgress?.({
        phase: "complete",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      return stats;
    }

    onProgress?.({
      phase: "embedding",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: pendingChunks.length,
    });

    const allContentHashes = pendingChunks.map((c) => c.contentHash);
    const missingHashes = new Set(database.getMissingEmbeddings(allContentHashes));
    
    const chunksNeedingEmbedding = pendingChunks.filter((c) => missingHashes.has(c.contentHash));
    const chunksWithExistingEmbedding = pendingChunks.filter((c) => !missingHashes.has(c.contentHash));

    for (const chunk of chunksWithExistingEmbedding) {
      const embeddingBuffer = database.getEmbedding(chunk.contentHash);
      if (embeddingBuffer) {
        const vector = bufferToFloat32Array(embeddingBuffer);
        store.add(chunk.id, Array.from(vector), chunk.metadata);
        invertedIndex.removeChunk(chunk.id);
        invertedIndex.addChunk(chunk.id, chunk.content);
        stats.indexedChunks++;
      }
    }

    const queue = new PQueue({ concurrency: 3 });
    const dynamicBatches = createDynamicBatches(chunksNeedingEmbedding);

    for (const batch of dynamicBatches) {
      queue.add(async () => {
        try {
          const result = await pRetry(
            async () => {
              const texts = batch.map((c) => c.text);
              return provider.embedBatch(texts);
            },
            {
              retries: this.config.indexing.retries,
              minTimeout: this.config.indexing.retryDelayMs,
              maxTimeout: 30000,
              factor: 2,
              onFailedAttempt: (error) => {
                const message = getErrorMessage(error);
                if (isRateLimitError(error)) {
                  queue.concurrency = 1;
                  console.error(
                    `Rate limited (attempt ${error.attemptNumber}/${error.retriesLeft + error.attemptNumber}): waiting before retry...`
                  );
                } else {
                  console.error(
                    `Embedding batch failed (attempt ${error.attemptNumber}): ${message}`
                  );
                }
              },
            }
          );

          const items = batch.map((chunk, idx) => ({
            id: chunk.id,
            vector: result.embeddings[idx],
            metadata: chunk.metadata,
          }));

          store.addBatch(items);
          
          for (let i = 0; i < batch.length; i++) {
            const chunk = batch[i];
            const embedding = result.embeddings[i];
            
            database.upsertEmbedding(
              chunk.contentHash,
              float32ArrayToBuffer(embedding),
              chunk.text,
              detectedProvider.modelInfo.model
            );
            
            invertedIndex.removeChunk(chunk.id);
            invertedIndex.addChunk(chunk.id, chunk.content);
          }
          
          stats.indexedChunks += batch.length;
          stats.tokensUsed += result.totalTokensUsed;

          onProgress?.({
            phase: "embedding",
            filesProcessed: files.length,
            totalFiles: files.length,
            chunksProcessed: stats.indexedChunks,
            totalChunks: pendingChunks.length,
          });
        } catch (error) {
          stats.failedChunks += batch.length;
          this.addFailedBatch(batch, getErrorMessage(error));
          console.error(`Failed to embed batch after retries: ${getErrorMessage(error)}`);
        }
      });
    }

    await queue.onIdle();

    onProgress?.({
      phase: "storing",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: pendingChunks.length,
    });

    database.clearBranch(this.currentBranch);
    database.addChunksToBranch(this.currentBranch, Array.from(currentChunkIds));

    store.save();
    invertedIndex.save();
    this.fileHashCache = currentFileHashes;
    this.saveFileHashCache();

    stats.durationMs = Date.now() - startTime;
    
    if (stats.failedChunks > 0) {
      stats.failedBatchesPath = this.failedBatchesPath;
    }

    onProgress?.({
      phase: "complete",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: pendingChunks.length,
    });

    return stats;
  }

  async search(
    query: string,
    limit?: number,
    options?: {
      hybridWeight?: number;
      fileType?: string;
      directory?: string;
      chunkType?: string;
      contextLines?: number;
      filterByBranch?: boolean;
    }
  ): Promise<
    Array<{
      filePath: string;
      startLine: number;
      endLine: number;
      content: string;
      score: number;
      chunkType: string;
      name?: string;
    }>
  > {
    const { store, provider, database } = await this.ensureInitialized();

    if (store.count() === 0) {
      return [];
    }

    const maxResults = limit ?? this.config.search.maxResults;
    const hybridWeight = options?.hybridWeight ?? this.config.search.hybridWeight;
    const filterByBranch = options?.filterByBranch ?? true;

    const { embedding } = await provider.embed(query);
    const semanticResults = store.search(embedding, maxResults * 4);

    const keywordResults = await this.keywordSearch(query, maxResults * 4);

    const combined = this.fuseResults(semanticResults, keywordResults, hybridWeight, maxResults * 4);

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && this.currentBranch !== "default") {
      branchChunkIds = new Set(database.getBranchChunkIds(this.currentBranch));
    }

    const filtered = combined.filter((r) => {
      if (r.score < this.config.search.minScore) return false;

      if (branchChunkIds && !branchChunkIds.has(r.id)) return false;

      if (options?.fileType) {
        const ext = r.metadata.filePath.split(".").pop()?.toLowerCase();
        if (ext !== options.fileType.toLowerCase().replace(/^\./, "")) return false;
      }

      if (options?.directory) {
        const normalizedDir = options.directory.replace(/^\/|\/$/g, "");
        if (!r.metadata.filePath.includes(`/${normalizedDir}/`) && 
            !r.metadata.filePath.includes(`${normalizedDir}/`)) return false;
      }

      if (options?.chunkType) {
        if (r.metadata.chunkType !== options.chunkType) return false;
      }

      return true;
    }).slice(0, maxResults);

    return Promise.all(
      filtered.map(async (r) => {
        let content = "";
        let contextStartLine = r.metadata.startLine;
        let contextEndLine = r.metadata.endLine;
        
        if (this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            const contextLines = options?.contextLines ?? this.config.search.contextLines;
            
            contextStartLine = Math.max(1, r.metadata.startLine - contextLines);
            contextEndLine = Math.min(lines.length, r.metadata.endLine + contextLines);
            
            content = lines
              .slice(contextStartLine - 1, contextEndLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: contextStartLine,
          endLine: contextEndLine,
          content,
          score: r.score,
          chunkType: r.metadata.chunkType,
          name: r.metadata.name,
        };
      })
    );
  }

  private async keywordSearch(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const { store, invertedIndex } = await this.ensureInitialized();
    const scores = invertedIndex.search(query);
    
    if (scores.size === 0) {
      return [];
    }

    const allMetadata = store.getAllMetadata();
    const metadataMap = new Map<string, ChunkMetadata>();
    for (const { key, metadata } of allMetadata) {
      metadataMap.set(key, metadata);
    }

    const results: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];
    for (const [chunkId, score] of scores) {
      const metadata = metadataMap.get(chunkId);
      if (metadata && score > 0) {
        results.push({ id: chunkId, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private fuseResults(
    semanticResults: Array<{ id: string; score: number; metadata: ChunkMetadata }>,
    keywordResults: Array<{ id: string; score: number; metadata: ChunkMetadata }>,
    keywordWeight: number,
    limit: number
  ): Array<{ id: string; score: number; metadata: ChunkMetadata }> {
    const semanticWeight = 1 - keywordWeight;
    const fusedScores = new Map<string, { score: number; metadata: ChunkMetadata }>();

    for (const r of semanticResults) {
      fusedScores.set(r.id, {
        score: r.score * semanticWeight,
        metadata: r.metadata,
      });
    }

    for (const r of keywordResults) {
      const existing = fusedScores.get(r.id);
      if (existing) {
        existing.score += r.score * keywordWeight;
      } else {
        fusedScores.set(r.id, {
          score: r.score * keywordWeight,
          metadata: r.metadata,
        });
      }
    }

    const results = Array.from(fusedScores.entries()).map(([id, data]) => ({
      id,
      score: data.score,
      metadata: data.metadata,
    }));

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getStatus(): Promise<{
    indexed: boolean;
    vectorCount: number;
    provider: string;
    model: string;
    indexPath: string;
    currentBranch: string;
    baseBranch: string;
  }> {
    const { store, detectedProvider } = await this.ensureInitialized();

    return {
      indexed: store.count() > 0,
      vectorCount: store.count(),
      provider: detectedProvider.provider,
      model: detectedProvider.modelInfo.model,
      indexPath: this.indexPath,
      currentBranch: this.currentBranch,
      baseBranch: this.baseBranch,
    };
  }

  async clearIndex(): Promise<void> {
    const { store, invertedIndex } = await this.ensureInitialized();

    store.clear();
    store.save();
    invertedIndex.clear();
    invertedIndex.save();
  }

  async healthCheck(): Promise<{ removed: number; filePaths: string[]; gcOrphanEmbeddings: number; gcOrphanChunks: number }> {
    const { store, invertedIndex, database } = await this.ensureInitialized();

    const allMetadata = store.getAllMetadata();
    const filePathsToChunkKeys = new Map<string, string[]>();

    for (const { key, metadata } of allMetadata) {
      const existing = filePathsToChunkKeys.get(metadata.filePath) || [];
      existing.push(key);
      filePathsToChunkKeys.set(metadata.filePath, existing);
    }

    const removedFilePaths: string[] = [];
    let removedCount = 0;

    for (const [filePath, chunkKeys] of filePathsToChunkKeys) {
      if (!existsSync(filePath)) {
        for (const key of chunkKeys) {
          store.remove(key);
          invertedIndex.removeChunk(key);
          removedCount++;
        }
        database.deleteChunksByFile(filePath);
        removedFilePaths.push(filePath);
      }
    }

    if (removedCount > 0) {
      store.save();
      invertedIndex.save();
    }

    const gcOrphanEmbeddings = database.gcOrphanEmbeddings();
    const gcOrphanChunks = database.gcOrphanChunks();

    return { removed: removedCount, filePaths: removedFilePaths, gcOrphanEmbeddings, gcOrphanChunks };
  }

  async retryFailedBatches(): Promise<{ succeeded: number; failed: number; remaining: number }> {
    const { store, provider, invertedIndex } = await this.ensureInitialized();
    
    const failedBatches = this.loadFailedBatches();
    if (failedBatches.length === 0) {
      return { succeeded: 0, failed: 0, remaining: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    const stillFailing: FailedBatch[] = [];

    for (const batch of failedBatches) {
      try {
        const result = await pRetry(
          async () => {
            const texts = batch.chunks.map((c) => c.text);
            return provider.embedBatch(texts);
          },
          {
            retries: this.config.indexing.retries,
            minTimeout: this.config.indexing.retryDelayMs,
          }
        );

        const items = batch.chunks.map((chunk, idx) => ({
          id: chunk.id,
          vector: result.embeddings[idx],
          metadata: chunk.metadata,
        }));

        store.addBatch(items);

        for (const chunk of batch.chunks) {
          invertedIndex.removeChunk(chunk.id);
          invertedIndex.addChunk(chunk.id, chunk.content);
        }

        succeeded += batch.chunks.length;
      } catch (error) {
        failed += batch.chunks.length;
        stillFailing.push({
          ...batch,
          attemptCount: batch.attemptCount + 1,
          lastAttempt: new Date().toISOString(),
          error: String(error),
        });
      }
    }

    this.saveFailedBatches(stillFailing);
    
    if (succeeded > 0) {
      store.save();
      invertedIndex.save();
    }

    return { succeeded, failed, remaining: stillFailing.length };
  }

  getFailedBatchesCount(): number {
    return this.loadFailedBatches().length;
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  getBaseBranch(): string {
    return this.baseBranch;
  }

  refreshBranchInfo(): void {
    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
    }
  }

  async getDatabaseStats(): Promise<{ embeddingCount: number; chunkCount: number; branchChunkCount: number; branchCount: number } | null> {
    const { database } = await this.ensureInitialized();
    return database.getStats();
  }
}
