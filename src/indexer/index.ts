import { existsSync, readFileSync, writeFileSync, promises as fsPromises } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
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
import { Logger, initializeLogger } from "../utils/logger.js";
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
  private logger: Logger;
  private queryEmbeddingCache: Map<string, { embedding: number[]; timestamp: number }> = new Map();
  private readonly maxQueryCacheSize = 100;
  private readonly queryCacheTtlMs = 5 * 60 * 1000;
  private readonly querySimilarityThreshold = 0.85;

  constructor(projectRoot: string, config: ParsedCodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
    this.fileHashCachePath = path.join(this.indexPath, "file-hashes.json");
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
    this.logger = initializeLogger(config.debug);
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

  private getProviderRateLimits(provider: string): { 
    concurrency: number; 
    intervalMs: number; 
    minRetryMs: number; 
    maxRetryMs: number; 
  } {
    switch (provider) {
      case "github-copilot":
        return { concurrency: 1, intervalMs: 4000, minRetryMs: 5000, maxRetryMs: 60000 };
      case "openai":
        return { concurrency: 3, intervalMs: 500, minRetryMs: 1000, maxRetryMs: 30000 };
      case "google":
        return { concurrency: 5, intervalMs: 200, minRetryMs: 1000, maxRetryMs: 30000 };
      case "ollama":
        return { concurrency: 5, intervalMs: 0, minRetryMs: 500, maxRetryMs: 5000 };
      default:
        return { concurrency: 3, intervalMs: 1000, minRetryMs: 1000, maxRetryMs: 30000 };
    }
  }

  async initialize(): Promise<void> {
    this.detectedProvider = await detectEmbeddingProvider(this.config.embeddingProvider);
    if (!this.detectedProvider) {
      throw new Error(
        "No embedding provider available. Configure GitHub, OpenAI, Google, or Ollama."
      );
    }

    this.logger.info("Initializing indexer", {
      provider: this.detectedProvider.provider,
      model: this.detectedProvider.modelInfo.model,
      scope: this.config.scope,
    });

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
      this.logger.branch("info", "Detected git repository", {
        currentBranch: this.currentBranch,
        baseBranch: this.baseBranch,
      });
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
      this.logger.branch("debug", "Not a git repository, using default branch");
    }

    // Auto-GC: Run garbage collection if enabled and interval has elapsed
    if (this.config.indexing.autoGc) {
      await this.maybeRunAutoGc();
    }
  }

  private async maybeRunAutoGc(): Promise<void> {
    if (!this.database) return;

    const lastGcTimestamp = this.database.getMetadata("lastGcTimestamp");
    const now = Date.now();
    const intervalMs = this.config.indexing.gcIntervalDays * 24 * 60 * 60 * 1000;

    let shouldRunGc = false;
    if (!lastGcTimestamp) {
      // Never run GC before, run it now
      shouldRunGc = true;
    } else {
      const lastGcTime = parseInt(lastGcTimestamp, 10);
      if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
        shouldRunGc = true;
      }
    }

    if (shouldRunGc) {
      await this.healthCheck();
      this.database.setMetadata("lastGcTimestamp", now.toString());
    }
  }

  private async maybeRunOrphanGc(): Promise<void> {
    if (!this.database) return;

    const stats = this.database.getStats();
    if (!stats) return;

    const orphanCount = stats.embeddingCount - stats.chunkCount;
    if (orphanCount > this.config.indexing.gcOrphanThreshold) {
      this.database.gcOrphanEmbeddings();
      this.database.gcOrphanChunks();
      this.database.setMetadata("lastGcTimestamp", Date.now().toString());
    }
  }

  private migrateFromLegacyIndex(): void {
    if (!this.store || !this.database) return;

    const allMetadata = this.store.getAllMetadata();
    const chunkIds: string[] = [];
    const chunkDataBatch: ChunkData[] = [];

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
      chunkDataBatch.push(chunkData);
      chunkIds.push(key);
    }

    if (chunkDataBatch.length > 0) {
      this.database.upsertChunksBatch(chunkDataBatch);
    }
    this.database.addChunksToBranchBatch(this.currentBranch || "default", chunkIds);
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

    this.logger.recordIndexingStart();
    this.logger.info("Starting indexing", { projectRoot: this.projectRoot });

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

    this.logger.recordFilesScanned(files.length);
    this.logger.cache("debug", "Scanning files for changes", {
      totalFiles: files.length,
      skippedFiles: skipped.length,
    });

    const changedFiles: Array<{ path: string; content: string; hash: string }> = [];
    const unchangedFilePaths = new Set<string>();
    const currentFileHashes = new Map<string, string>();

    for (const f of files) {
      const currentHash = hashFile(f.path);
      currentFileHashes.set(f.path, currentHash);
      
      if (this.fileHashCache.get(f.path) === currentHash) {
        unchangedFilePaths.add(f.path);
        this.logger.recordCacheHit();
      } else {
        const content = await fsPromises.readFile(f.path, "utf-8");
        changedFiles.push({ path: f.path, content, hash: currentHash });
        this.logger.recordCacheMiss();
      }
    }

    this.logger.cache("info", "File hash cache results", {
      unchanged: unchangedFilePaths.size,
      changed: changedFiles.length,
    });

    onProgress?.({
      phase: "parsing",
      filesProcessed: 0,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const parseStartTime = performance.now();
    const parsedFiles = parseFiles(changedFiles);
    const parseMs = performance.now() - parseStartTime;
    
    this.logger.recordFilesParsed(parsedFiles.length);
    this.logger.recordParseDuration(parseMs);
    this.logger.debug("Parsed changed files", { parsedCount: parsedFiles.length, parseMs: parseMs.toFixed(2) });

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

    const chunkDataBatch: ChunkData[] = [];

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
        chunkDataBatch.push(chunkData);

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

    if (chunkDataBatch.length > 0) {
      database.upsertChunksBatch(chunkDataBatch);
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

    this.logger.recordChunksProcessed(currentChunkIds.size);
    this.logger.recordChunksRemoved(removedCount);
    this.logger.info("Chunk analysis complete", {
      pending: pendingChunks.length,
      existing: stats.existingChunks,
      removed: removedCount,
    });

    if (pendingChunks.length === 0 && removedCount === 0) {
      database.clearBranch(this.currentBranch);
      database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));
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
      database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));
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

    this.logger.cache("info", "Embedding cache lookup", {
      needsEmbedding: chunksNeedingEmbedding.length,
      fromCache: chunksWithExistingEmbedding.length,
    });
    this.logger.recordChunksFromCache(chunksWithExistingEmbedding.length);

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

    const providerRateLimits = this.getProviderRateLimits(detectedProvider.provider);
    const queue = new PQueue({ 
      concurrency: providerRateLimits.concurrency, 
      interval: providerRateLimits.intervalMs, 
      intervalCap: providerRateLimits.concurrency 
    });
    const dynamicBatches = createDynamicBatches(chunksNeedingEmbedding);
    let rateLimitBackoffMs = 0;

    for (const batch of dynamicBatches) {
      queue.add(async () => {
        if (rateLimitBackoffMs > 0) {
          await new Promise(resolve => setTimeout(resolve, rateLimitBackoffMs));
        }
        
        try {
          const result = await pRetry(
            async () => {
              const texts = batch.map((c) => c.text);
              return provider.embedBatch(texts);
            },
            {
              retries: this.config.indexing.retries,
              minTimeout: Math.max(this.config.indexing.retryDelayMs, providerRateLimits.minRetryMs),
              maxTimeout: providerRateLimits.maxRetryMs,
              factor: 2,
              onFailedAttempt: (error) => {
                const message = getErrorMessage(error);
                if (isRateLimitError(error)) {
                  rateLimitBackoffMs = Math.min(providerRateLimits.maxRetryMs, (rateLimitBackoffMs || providerRateLimits.minRetryMs) * 2);
                  this.logger.embedding("warn", `Rate limited, backing off`, {
                    attempt: error.attemptNumber,
                    retriesLeft: error.retriesLeft,
                    backoffMs: rateLimitBackoffMs,
                  });
                } else {
                  this.logger.embedding("error", `Embedding batch failed`, {
                    attempt: error.attemptNumber,
                    error: message,
                  });
                }
              },
            }
          );
          
          if (rateLimitBackoffMs > 0) {
            rateLimitBackoffMs = Math.max(0, rateLimitBackoffMs - 2000);
          }

          const items = batch.map((chunk, idx) => ({
            id: chunk.id,
            vector: result.embeddings[idx],
            metadata: chunk.metadata,
          }));

          store.addBatch(items);
          
          const embeddingBatchItems = batch.map((chunk, i) => ({
            contentHash: chunk.contentHash,
            embedding: float32ArrayToBuffer(result.embeddings[i]),
            chunkText: chunk.text,
            model: detectedProvider.modelInfo.model,
          }));
          database.upsertEmbeddingsBatch(embeddingBatchItems);

          for (const chunk of batch) {
            invertedIndex.removeChunk(chunk.id);
            invertedIndex.addChunk(chunk.id, chunk.content);
          }
          
          stats.indexedChunks += batch.length;
          stats.tokensUsed += result.totalTokensUsed;

          this.logger.recordChunksEmbedded(batch.length);
          this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
          this.logger.embedding("debug", `Embedded batch`, {
            batchSize: batch.length,
            tokens: result.totalTokensUsed,
          });

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
          this.logger.recordEmbeddingError();
          this.logger.embedding("error", `Failed to embed batch after retries`, {
            batchSize: batch.length,
            error: getErrorMessage(error),
          });
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
    database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));

    store.save();
    invertedIndex.save();
    this.fileHashCache = currentFileHashes;
    this.saveFileHashCache();

    // Auto-GC after indexing: check if orphan count exceeds threshold
    if (this.config.indexing.autoGc && stats.removedChunks > 0) {
      await this.maybeRunOrphanGc();
    }

    stats.durationMs = Date.now() - startTime;
    
    this.logger.recordIndexingEnd();
    this.logger.info("Indexing complete", {
      files: stats.totalFiles,
      indexed: stats.indexedChunks,
      existing: stats.existingChunks,
      removed: stats.removedChunks,
      failed: stats.failedChunks,
      tokens: stats.tokensUsed,
      durationMs: stats.durationMs,
    });

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

  private async getQueryEmbedding(query: string, provider: EmbeddingProviderInterface): Promise<number[]> {
    const now = Date.now();
    const cached = this.queryEmbeddingCache.get(query);
    
    if (cached && (now - cached.timestamp) < this.queryCacheTtlMs) {
      this.logger.cache("debug", "Query embedding cache hit (exact)", { query: query.slice(0, 50) });
      this.logger.recordQueryCacheHit();
      return cached.embedding;
    }
    
    const similarMatch = this.findSimilarCachedQuery(query, now);
    if (similarMatch) {
      this.logger.cache("debug", "Query embedding cache hit (similar)", { 
        query: query.slice(0, 50),
        similarTo: similarMatch.key.slice(0, 50),
        similarity: similarMatch.similarity.toFixed(3),
      });
      this.logger.recordQueryCacheSimilarHit();
      return similarMatch.embedding;
    }
    
    this.logger.cache("debug", "Query embedding cache miss", { query: query.slice(0, 50) });
    this.logger.recordQueryCacheMiss();
    const { embedding, tokensUsed } = await provider.embed(query);
    this.logger.recordEmbeddingApiCall(tokensUsed);
    
    if (this.queryEmbeddingCache.size >= this.maxQueryCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (oldestKey) {
        this.queryEmbeddingCache.delete(oldestKey);
      }
    }
    
    this.queryEmbeddingCache.set(query, { embedding, timestamp: now });
    return embedding;
  }

  private findSimilarCachedQuery(
    query: string, 
    now: number
  ): { key: string; embedding: number[]; similarity: number } | null {
    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) return null;
    
    let bestMatch: { key: string; embedding: number[]; similarity: number } | null = null;
    
    for (const [cachedQuery, { embedding, timestamp }] of this.queryEmbeddingCache) {
      if ((now - timestamp) >= this.queryCacheTtlMs) continue;
      
      const cachedTokens = this.tokenize(cachedQuery);
      const similarity = this.jaccardSimilarity(queryTokens, cachedTokens);
      
      if (similarity >= this.querySimilarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { key: cachedQuery, embedding, similarity };
        }
      }
    }
    
    return bestMatch;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1)
    );
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    
    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }
    
    const union = a.size + b.size - intersection;
    return intersection / union;
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
      metadataOnly?: boolean;
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
    const searchStartTime = performance.now();
    const { store, provider, database } = await this.ensureInitialized();

    if (store.count() === 0) {
      this.logger.search("debug", "Search on empty index", { query });
      return [];
    }

    const maxResults = limit ?? this.config.search.maxResults;
    const hybridWeight = options?.hybridWeight ?? this.config.search.hybridWeight;
    const filterByBranch = options?.filterByBranch ?? true;

    this.logger.search("debug", "Starting search", {
      query,
      maxResults,
      hybridWeight,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const embedding = await this.getQueryEmbedding(query, provider);
    const embeddingMs = performance.now() - embeddingStartTime;

    const vectorStartTime = performance.now();
    const semanticResults = store.search(embedding, maxResults * 4);
    const vectorMs = performance.now() - vectorStartTime;

    const keywordStartTime = performance.now();
    const keywordResults = await this.keywordSearch(query, maxResults * 4);
    const keywordMs = performance.now() - keywordStartTime;

    const fusionStartTime = performance.now();
    const combined = this.fuseResults(semanticResults, keywordResults, hybridWeight, maxResults * 4);
    const fusionMs = performance.now() - fusionStartTime;

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

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs,
      fusionMs,
    });
    this.logger.search("info", "Search complete", {
      query,
      results: filtered.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      keywordMs: Math.round(keywordMs * 100) / 100,
      fusionMs: Math.round(fusionMs * 100) / 100,
    });

    const metadataOnly = options?.metadataOnly ?? false;

    return Promise.all(
      filtered.map(async (r) => {
        let content = "";
        let contextStartLine = r.metadata.startLine;
        let contextEndLine = r.metadata.endLine;
        
        if (!metadataOnly && this.config.search.includeContext) {
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

    // Only fetch metadata for chunks returned by BM25 (O(n) where n = result count)
    // instead of getAllMetadata() which fetches ALL chunks in the index
    const chunkIds = Array.from(scores.keys());
    const metadataMap = store.getMetadataBatch(chunkIds);

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
    const { store, invertedIndex, database } = await this.ensureInitialized();

    store.clear();
    store.save();
    invertedIndex.clear();
    invertedIndex.save();
    
    // Clear file hash cache so all files are re-parsed
    this.fileHashCache.clear();
    this.saveFileHashCache();
    
    // Clear branch catalog
    database.clearBranch(this.currentBranch);
  }

  async healthCheck(): Promise<{ removed: number; filePaths: string[]; gcOrphanEmbeddings: number; gcOrphanChunks: number }> {
    const { store, invertedIndex, database } = await this.ensureInitialized();

    this.logger.gc("info", "Starting health check");

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

    this.logger.recordGc(removedCount, gcOrphanChunks, gcOrphanEmbeddings);
    this.logger.gc("info", "Health check complete", {
      removedStale: removedCount,
      orphanEmbeddings: gcOrphanEmbeddings,
      orphanChunks: gcOrphanChunks,
      removedFiles: removedFilePaths.length,
    });

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

        this.logger.recordChunksEmbedded(batch.chunks.length);
        this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
        
        succeeded += batch.chunks.length;
      } catch (error) {
        failed += batch.chunks.length;
        this.logger.recordEmbeddingError();
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

  getLogger(): Logger {
    return this.logger;
  }
}
