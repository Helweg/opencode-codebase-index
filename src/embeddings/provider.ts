import { EmbeddingModelInfo, EmbeddingProviderModelInfo } from "../config/schema.js";
import { ConfiguredProviderInfo, ProviderCredentials } from "./detector.js";

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
  getModelInfo(): EmbeddingModelInfo;
}

export function createEmbeddingProvider(
  configuredProviderInfo: ConfiguredProviderInfo,
): EmbeddingProviderInterface {
  switch (configuredProviderInfo.provider) {
    case "github-copilot":
      return new GitHubCopilotEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "openai":
      return new OpenAIEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "google":
      return new GoogleEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "ollama":
      return new OllamaEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    default: {
      const _exhaustive: never = configuredProviderInfo;
      throw new Error(`Unsupported embedding provider: ${(_exhaustive as ConfiguredProviderInfo).provider}`);
    }
  }
}

class GitHubCopilotEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['github-copilot']
  ) { }

  private getToken(): string {
    if (!this.credentials.refreshToken) {
      throw new Error("No OAuth token available for GitHub");
    }
    return this.credentials.refreshToken;
  }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
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

  getModelInfo(): EmbeddingModelInfo {
    return this.modelInfo;
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['openai']
  ) { }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
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

  getModelInfo(): EmbeddingModelInfo {
    return this.modelInfo;
  }
}

class GoogleEmbeddingProvider implements EmbeddingProviderInterface {
  private static readonly BATCH_SIZE = 20;

  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['google']
  ) { }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.taskAble ? "CODE_RETRIEVAL_QUERY" : undefined;
    const result = await this.embedWithTaskType([query], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.taskAble ? "RETRIEVAL_DOCUMENT" : undefined;
    const result = await this.embedWithTaskType([document], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const taskType = this.modelInfo.taskAble ? "RETRIEVAL_DOCUMENT" : undefined;
    return this.embedWithTaskType(texts, taskType);
  }

  /**
   * Embeds texts using the Google embedContent API.
   * Sends multiple texts as parts in batched requests (up to BATCH_SIZE per call).
   * When taskType is provided (gemini-embedding-001), includes it in the request
   * for task-specific embedding optimization.
   */
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

  getModelInfo(): EmbeddingModelInfo {
    return this.modelInfo;
  }
}

class OllamaEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['ollama']
  ) { }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const results = await Promise.all(
      texts.map(async (text) => {
        const response = await fetch(`${this.credentials.baseUrl}/api/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.modelInfo.model,
            prompt: text,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Ollama embedding API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as {
          embedding: number[];
        };

        return {
          embedding: data.embedding,
          tokensUsed: Math.ceil(text.length / 4),
        };
      })
    );

    return {
      embeddings: results.map((r) => r.embedding),
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }

  getModelInfo(): EmbeddingModelInfo {
    return this.modelInfo;
  }
}
