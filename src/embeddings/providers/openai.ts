import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import { BaseEmbeddingProvider, type EmbeddingBatchResult } from "../provider-types.js";

export class OpenAIEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["openai"]> {
  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["openai"]
  ) {
    super(credentials, modelInfo);
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const response = await fetch(`${this.credentials.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelInfo.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    return {
      embeddings: data.data.map((d) => d.embedding),
      totalTokensUsed: data.usage.total_tokens,
    };
  }
}
