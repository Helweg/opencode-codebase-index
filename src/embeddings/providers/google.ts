import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  type EmbeddingBatchResult,
  type EmbeddingResult,
} from "../provider-types.js";

export class GoogleEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["google"]> {
  private static readonly BATCH_SIZE = 20;

  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["google"]
  ) {
    super(credentials, modelInfo);
  }

  public async embedQuery(query: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.taskAble ? "CODE_RETRIEVAL_QUERY" : undefined;
    const result = await this.embedWithTaskType([query], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedDocument(document: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.taskAble ? "RETRIEVAL_DOCUMENT" : undefined;
    const result = await this.embedWithTaskType([document], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const taskType = this.modelInfo.taskAble ? "RETRIEVAL_DOCUMENT" : undefined;
    return this.embedWithTaskType(texts, taskType);
  }

  private async embedWithTaskType(
    texts: string[],
    taskType?: string
  ): Promise<EmbeddingBatchResult> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += GoogleEmbeddingProvider.BATCH_SIZE) {
      batches.push(texts.slice(i, i + GoogleEmbeddingProvider.BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const requests = batch.map((text) => ({
          model: `models/${this.modelInfo.model}`,
          content: {
            parts: [{ text }],
          },
          taskType,
          outputDimensionality: this.modelInfo.dimensions,
        }));

        const response = await fetch(
          `${this.credentials.baseUrl}/models/${this.modelInfo.model}:batchEmbedContents?key=${this.credentials.apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ requests }),
          }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Google embedding API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as {
          embeddings: Array<{ values: number[] }>;
        };

        return {
          embeddings: data.embeddings.map((e) => e.values),
          tokensUsed: batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        };
      })
    );

    return {
      embeddings: batchResults.flatMap((r) => r.embeddings),
      totalTokensUsed: batchResults.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }
}
