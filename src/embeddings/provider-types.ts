import { type BaseModelInfo } from "../config/schema.js";

import { type ProviderCredentials } from "./detector.js";

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  totalTokensUsed: number;
}

export interface EmbeddingProviderInterface {
  embedQuery(query: string): Promise<EmbeddingResult>;
  embedDocument(document: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;
  getModelInfo(): BaseModelInfo;
}

export abstract class BaseEmbeddingProvider<TModelInfo extends BaseModelInfo>
  implements EmbeddingProviderInterface {
  public constructor(
    protected readonly credentials: ProviderCredentials,
    protected readonly modelInfo: TModelInfo
  ) { }

  public async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public getModelInfo(): TModelInfo {
    return this.modelInfo;
  }

  public abstract embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;
}

/**
 * Thrown by CustomEmbeddingProvider for HTTP 4xx errors (except 429 rate limit).
 * The Indexer's pRetry config uses instanceof to bail immediately on these errors
 * instead of retrying — preventing long retry loops on bad API keys or invalid models.
 */
export class CustomProviderNonRetryableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CustomProviderNonRetryableError";
  }
}
