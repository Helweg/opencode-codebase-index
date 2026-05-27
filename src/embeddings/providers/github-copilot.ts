import { type EmbeddingProviderModelInfo } from "../../config/schema.js";

import { type ProviderCredentials } from "../detector.js";
import { BaseEmbeddingProvider, type EmbeddingBatchResult } from "../provider-types.js";

export class GitHubCopilotEmbeddingProvider extends BaseEmbeddingProvider<EmbeddingProviderModelInfo["github-copilot"]> {
  public constructor(
    credentials: ProviderCredentials,
    modelInfo: EmbeddingProviderModelInfo["github-copilot"]
  ) {
    super(credentials, modelInfo);
  }

  private getToken(): string {
    if (!this.credentials.refreshToken) {
      throw new Error("No OAuth token available for GitHub");
    }
    return this.credentials.refreshToken;
  }

  public async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const token = this.getToken();

    const response = await fetch(`${this.credentials.baseUrl}/inference/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        model: `openai/${this.modelInfo.model}`,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub Copilot embedding API error: ${response.status} - ${error}`);
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
