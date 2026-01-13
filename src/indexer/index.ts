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
  ChunkMetadata,
  hashContent,
} from "../native/index.js";

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  durationMs: number;
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
  metadata: ChunkMetadata;
}

export class Indexer {
  private config: CodebaseIndexConfig;
  private projectRoot: string;
  private indexPath: string;
  private store: VectorStore | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private detectedProvider: DetectedProvider | null = null;

  constructor(projectRoot: string, config: CodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
  }

  private getIndexPath(): string {
    if (this.config.scope === "global") {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      return path.join(homeDir, ".opencode", "global-index");
    }
    return path.join(this.projectRoot, ".opencode", "index");
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
    };

    onProgress?.({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const files = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    stats.totalFiles = files.length;

    onProgress?.({
      phase: "parsing",
      filesProcessed: 0,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const fileContents = await Promise.all(
      files.map(async (f) => ({
        path: f.path,
        content: await fs.promises.readFile(f.path, "utf-8"),
      }))
    );

    const parsedFiles = parseFiles(fileContents);
    const existingHashes = await this.loadHashIndex();
    const pendingChunks: PendingChunk[] = [];

    for (const parsed of parsedFiles) {
      const fileHash = hashContent(parsed.hash);

      if (existingHashes.get(parsed.path) === fileHash) {
        continue;
      }

      for (const chunk of parsed.chunks) {
        const id = generateChunkId(parsed.path, chunk);
        const text = createEmbeddingText(chunk, parsed.path);
        const metadata: ChunkMetadata = {
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
          hash: fileHash,
        };

        pendingChunks.push({ id, text, metadata });
      }

      existingHashes.set(parsed.path, fileHash);
    }

    stats.totalChunks = pendingChunks.length;

    if (pendingChunks.length === 0) {
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

    const queue = new PQueue({ concurrency: 1 });
    const batchSize = this.config.indexing.batchSize;

    for (let i = 0; i < pendingChunks.length; i += batchSize) {
      const batch = pendingChunks.slice(i, i + batchSize);

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
    await this.saveHashIndex(existingHashes);

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
    limit?: number
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

    const { embedding } = await this.provider!.embed(query);
    const maxResults = limit ?? this.config.search.maxResults;
    const results = this.store!.search(embedding, maxResults);

    const filtered = results.filter(
      (r) => r.score >= this.config.search.minScore
    );

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

    const hashIndexPath = path.join(this.indexPath, "hashes.json");
    if (fs.existsSync(hashIndexPath)) {
      await fs.promises.unlink(hashIndexPath);
    }
  }

  private async loadHashIndex(): Promise<Map<string, string>> {
    const hashIndexPath = path.join(this.indexPath, "hashes.json");

    if (!fs.existsSync(hashIndexPath)) {
      return new Map();
    }

    try {
      const content = await fs.promises.readFile(hashIndexPath, "utf-8");
      const data = JSON.parse(content) as Record<string, string>;
      return new Map(Object.entries(data));
    } catch {
      return new Map();
    }
  }

  private async saveHashIndex(hashes: Map<string, string>): Promise<void> {
    const hashIndexPath = path.join(this.indexPath, "hashes.json");
    const data = Object.fromEntries(hashes);
    await fs.promises.writeFile(hashIndexPath, JSON.stringify(data, null, 2));
  }
}
