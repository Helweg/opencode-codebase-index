import { type CustomModelInfo, type ProviderCredentials } from "../detector.js";
import {
  BaseEmbeddingProvider,
  CustomProviderNonRetryableError,
  type EmbeddingBatchResult,
} from "../provider-types.js";

export class CustomEmbeddingProvider extends BaseEmbeddingProvider<CustomModelInfo> {
  public constructor(credentials: ProviderCredentials, modelInfo: CustomModelInfo) {
    super(credentials, modelInfo);
  }

  private splitIntoRequestBatches(texts: string[]): string[][] {
    const maxBatchSize = this.modelInfo.maxBatchSize;

    if (!maxBatchSize || texts.length <= maxBatchSize) {
      return [texts];
    }

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += maxBatchSize) {
      batches.push(texts.slice(i, i + maxBatchSize));
    }
    return batches;
  }

  private async embedRequest(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return {
        embeddings: [],
        totalTokensUsed: 0,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.credentials.apiKey) {
      headers.Authorization = `Bearer ${this.credentials.apiKey}`;
    }

    const baseUrl = this.credentials.baseUrl ?? "";
    const timeoutMs = this.modelInfo.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.modelInfo.model,
          input: texts,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Custom embedding API request timed out after ${timeoutMs}ms for ${baseUrl}/embeddings`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new CustomProviderNonRetryableError(`Custom embedding API error (non-retryable): ${response.status} - ${errorText}`);
      }
      throw new Error(`Custom embedding API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      data?: Array<{ embedding: number[] }>;
      usage?: { total_tokens: number };
    };

    if (data.data && Array.isArray(data.data)) {
      if (data.data.length > 0) {
        const actualDims = data.data[0].embedding.length;
        if (actualDims !== this.modelInfo.dimensions) {
          throw new Error(
            `Dimension mismatch: customProvider.dimensions is ${this.modelInfo.dimensions}, ` +
            `but the API returned vectors with ${actualDims} dimensions. ` +
            `Update your config to match the model's actual output dimensions.`
          );
        }
      }

      if (data.data.length !== texts.length) {
        throw new Error(
          `Embedding count mismatch: sent ${texts.length} texts but received ${data.data.length} embeddings. ` +
          `The custom embedding server may not support batch input.`
        );
      }

      return {
        embeddings: data.data.map((d) => d.embedding),
        totalTokensUsed: data.usage?.total_tokens ?? texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
      };
    }

    throw new Error("Custom embedding API returned unexpected response format. Expected OpenAI-compatible format with data[].embedding.");
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const requestBatches = this.splitIntoRequestBatches(texts);
    const embeddings: number[][] = [];
    let totalTokensUsed = 0;

    for (const batch of requestBatches) {
      const result = await this.embedRequest(batch);
      embeddings.push(...result.embeddings);
      totalTokensUsed += result.totalTokensUsed;
    }

    return {
      embeddings,
      totalTokensUsed,
    };
  }
}
