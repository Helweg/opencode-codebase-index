import { EmbeddingModelInfo } from "../config/schema.js";
import { ProviderCredentials } from "./detector.js";

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  totalTokensUsed: number;
}

export interface EmbeddingProviderInterface {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;
  getModelInfo(): EmbeddingModelInfo;
}

export function createEmbeddingProvider(
  credentials: ProviderCredentials,
  modelInfo: EmbeddingModelInfo
): EmbeddingProviderInterface {
  switch (credentials.provider) {
    case "github-copilot":
      return new GitHubCopilotEmbeddingProvider(credentials, modelInfo);
    case "openai":
      return new OpenAIEmbeddingProvider(credentials, modelInfo);
    case "google":
      return new GoogleEmbeddingProvider(credentials, modelInfo);
    case "ollama":
      return new OllamaEmbeddingProvider(credentials, modelInfo);
    default:
      throw new Error(`Unsupported embedding provider: ${credentials.provider}`);
  }
}

class GitHubCopilotEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingModelInfo
  ) {}

  private getToken(): string {
    if (!this.credentials.refreshToken) {
      throw new Error("No OAuth token available for GitHub");
    }
    return this.credentials.refreshToken;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([text]);
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
    private modelInfo: EmbeddingModelInfo
  ) {}

  async embed(text: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([text]);
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
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingModelInfo
  ) {}

  async embed(text: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([text]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const results = await Promise.all(
      texts.map(async (text) => {
        const response = await fetch(
          `${this.credentials.baseUrl}/models/${this.modelInfo.model}:embedContent?key=${this.credentials.apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: {
                parts: [{ text }],
              },
            }),
          }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Google embedding API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
          embedding: { values: number[] };
        };

        return {
          embedding: data.embedding.values,
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

class OllamaEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingModelInfo
  ) {}

  async embed(text: string): Promise<EmbeddingResult> {
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

    const data = await response.json() as {
      embedding: number[];
    };

    return {
      embedding: data.embedding,
      tokensUsed: Math.ceil(text.length / 4),
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const results = await Promise.all(texts.map((text) => this.embed(text)));
    
    return {
      embeddings: results.map((r) => r.embedding),
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }

  getModelInfo(): EmbeddingModelInfo {
    return this.modelInfo;
  }
}
