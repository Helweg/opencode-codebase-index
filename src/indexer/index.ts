import * as fs from "fs";
import * as path from "path";
import PQueue from "p-queue";
import pRetry from "p-retry";

import { CodebaseIndexConfig } from "../config/schema.js";
import { detectEmbeddingProvider, DetectedProvider } from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
} from "../embeddings/provider.js";
import { collectFiles } from "../utils/files.js";
import { createCostEstimate, CostEstimate } from "../utils/cost.js";
import {
  VectorStore,
  parseFiles,
  createEmbeddingText,
  generateChunkId,
  generateChunkHash,
  ChunkMetadata,
  createDynamicBatches,
  hashFile,
} from "../native/index.js";
import { InvertedIndex } from "./inverted-index.js";

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  durationMs: number;
  existingChunks: number;
  removedChunks: number;
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
  metadata: ChunkMetadata;
}

export class Indexer {
  private config: CodebaseIndexConfig;
  private projectRoot: string;
  private indexPath: string;
  private store: VectorStore | null = null;
  private invertedIndex: InvertedIndex | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private detectedProvider: DetectedProvider | null = null;
  private fileHashCache: Map<string, string> = new Map();
  private fileHashCachePath: string = "";

  constructor(projectRoot: string, config: CodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
    this.fileHashCachePath = path.join(this.indexPath, "file-hashes.json");
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
      if (fs.existsSync(this.fileHashCachePath)) {
        const data = fs.readFileSync(this.fileHashCachePath, "utf-8");
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
    fs.writeFileSync(this.fileHashCachePath, JSON.stringify(obj));
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

    await fs.promises.mkdir(this.indexPath, { recursive: true });

    const dimensions = this.detectedProvider.modelInfo.dimensions;
    const storePath = path.join(this.indexPath, "vectors");
    this.store = new VectorStore(storePath, dimensions);

    const indexFilePath = path.join(this.indexPath, "vectors.usearch");
    if (fs.existsSync(indexFilePath)) {
      this.store.load();
    }

    this.invertedIndex = new InvertedIndex(this.indexPath);
    this.invertedIndex.load();
  }

  async estimateCost(): Promise<CostEstimate> {
    if (!this.detectedProvider) {
      await this.initialize();
    }

    const files = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    return createCostEstimate(files, this.detectedProvider!);
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    if (!this.store || !this.provider) {
      await this.initialize();
    }

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
    };

    onProgress?.({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    this.loadFileHashCache();

    const files = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    stats.totalFiles = files.length;

    const changedFiles: Array<{ path: string; content: string; hash: string }> = [];
    const unchangedFilePaths = new Set<string>();
    const currentFileHashes = new Map<string, string>();

    for (const f of files) {
      const currentHash = hashFile(f.path);
      currentFileHashes.set(f.path, currentHash);
      
      if (this.fileHashCache.get(f.path) === currentHash) {
        unchangedFilePaths.add(f.path);
      } else {
        const content = await fs.promises.readFile(f.path, "utf-8");
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
    for (const { key, metadata } of this.store!.getAllMetadata()) {
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
      
      for (const chunk of parsed.chunks) {
        const id = generateChunkId(parsed.path, chunk);
        const contentHash = generateChunkHash(chunk);
        currentChunkIds.add(id);

        if (existingChunks.get(id) === contentHash) {
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

        pendingChunks.push({ id, text, content: chunk.content, metadata });
      }
    }

    let removedCount = 0;
    for (const [chunkId, _hash] of existingChunks) {
      if (!currentChunkIds.has(chunkId)) {
        this.store!.remove(chunkId);
        this.invertedIndex!.removeChunk(chunkId);
        removedCount++;
      }
    }

    stats.totalChunks = pendingChunks.length;
    stats.existingChunks = currentChunkIds.size - pendingChunks.length;
    stats.removedChunks = removedCount;

    if (pendingChunks.length === 0 && removedCount === 0) {
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
      this.store!.save();
      this.invertedIndex!.save();
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

    const queue = new PQueue({ concurrency: 3 });
    const dynamicBatches = createDynamicBatches(pendingChunks);

    for (const batch of dynamicBatches) {
      queue.add(async () => {
        try {
          const result = await pRetry(
            async () => {
              const texts = batch.map((c) => c.text);
              return this.provider!.embedBatch(texts);
            },
            {
              retries: this.config.indexing.retries,
              minTimeout: this.config.indexing.retryDelayMs,
              onFailedAttempt: (error) => {
                console.error(
                  `Embedding batch failed (attempt ${error.attemptNumber}): ${error.message}`
                );
              },
            }
          );

          const items = batch.map((chunk, idx) => ({
            id: chunk.id,
            vector: result.embeddings[idx],
            metadata: chunk.metadata,
          }));

          this.store!.addBatch(items);
          
          for (const chunk of batch) {
            this.invertedIndex!.removeChunk(chunk.id);
            this.invertedIndex!.addChunk(chunk.id, chunk.content);
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
          console.error(`Failed to embed batch after retries: ${error}`);
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

    this.store!.save();
    this.invertedIndex!.save();
    this.fileHashCache = currentFileHashes;
    this.saveFileHashCache();

    stats.durationMs = Date.now() - startTime;

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
    if (!this.store || !this.provider) {
      await this.initialize();
    }

    if (this.store!.count() === 0) {
      return [];
    }

    const maxResults = limit ?? this.config.search.maxResults;
    const hybridWeight = options?.hybridWeight ?? 0.5;

    const { embedding } = await this.provider!.embed(query);
    const semanticResults = this.store!.search(embedding, maxResults * 4);

    const keywordResults = await this.keywordSearch(query, maxResults * 4);

    const combined = this.fuseResults(semanticResults, keywordResults, hybridWeight, maxResults * 4);

    const filtered = combined.filter((r) => {
      if (r.score < this.config.search.minScore) return false;

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
        if (this.config.search.includeContext) {
          try {
            const fileContent = await fs.promises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            content = lines
              .slice(r.metadata.startLine - 1, r.metadata.endLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: r.metadata.startLine,
          endLine: r.metadata.endLine,
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
    const scores = this.invertedIndex!.search(query);
    
    if (scores.size === 0) {
      return [];
    }

    const allMetadata = this.store!.getAllMetadata();
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
  }> {
    if (!this.store) {
      await this.initialize();
    }

    return {
      indexed: this.store!.count() > 0,
      vectorCount: this.store!.count(),
      provider: this.detectedProvider?.provider ?? "unknown",
      model: this.detectedProvider?.modelInfo.model ?? "unknown",
      indexPath: this.indexPath,
    };
  }

  async clearIndex(): Promise<void> {
    if (!this.store) {
      await this.initialize();
    }

    this.store!.clear();
    this.store!.save();
    this.invertedIndex!.clear();
    this.invertedIndex!.save();
  }

  async healthCheck(): Promise<{ removed: number; filePaths: string[] }> {
    if (!this.store) {
      await this.initialize();
    }

    const allMetadata = this.store!.getAllMetadata();
    const filePathsToChunkKeys = new Map<string, string[]>();

    for (const { key, metadata } of allMetadata) {
      const existing = filePathsToChunkKeys.get(metadata.filePath) || [];
      existing.push(key);
      filePathsToChunkKeys.set(metadata.filePath, existing);
    }

    const removedFilePaths: string[] = [];
    let removedCount = 0;

    for (const [filePath, chunkKeys] of filePathsToChunkKeys) {
      if (!fs.existsSync(filePath)) {
        for (const key of chunkKeys) {
          this.store!.remove(key);
          this.invertedIndex!.removeChunk(key);
          removedCount++;
        }
        removedFilePaths.push(filePath);
      }
    }

    if (removedCount > 0) {
      this.store!.save();
      this.invertedIndex!.save();
    }

    return { removed: removedCount, filePaths: removedFilePaths };
  }
}
