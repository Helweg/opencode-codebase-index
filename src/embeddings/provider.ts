import { EmbeddingModelInfo } from "../config/schema.js";
import { ProviderCredentials } from "./detector.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
    case "github":
      return new GitHubEmbeddingProvider(credentials, modelInfo);
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

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-edits",
};

class GitHubCopilotEmbeddingProvider implements EmbeddingProviderInterface {
  private accessToken: string;
  private tokenExpires: number;

  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingModelInfo
  ) {
    this.accessToken = credentials.accessToken || "";
    this.tokenExpires = credentials.tokenExpires || 0;
  }

  private async ensureValidToken(): Promise<string> {
    if (this.accessToken && this.tokenExpires > Date.now()) {
      return this.accessToken;
    }

    if (!this.credentials.refreshToken) {
      throw new Error("No refresh token available for GitHub Copilot");
    }

    const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.credentials.refreshToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const tokenData = await response.json() as { token: string; expires_at: number };
    this.accessToken = tokenData.token;
    this.tokenExpires = tokenData.expires_at * 1000 - 5 * 60 * 1000;

    this.persistToken(tokenData.token, this.tokenExpires);

    return this.accessToken;
  }

  private persistToken(token: string, expires: number): void {
    try {
      const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
      const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      
      if (authData["github-copilot"]) {
        authData["github-copilot"].access = token;
        authData["github-copilot"].expires = expires;
        fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
      }
    } catch {
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([text]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const token = await this.ensureValidToken();

    const response = await fetch(`${this.credentials.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({
        model: this.modelInfo.model,
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

class GitHubEmbeddingProvider implements EmbeddingProviderInterface {
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
    const response = await fetch(
      `${this.credentials.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelInfo.model,
          input: texts,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub embedding API error: ${response.status} - ${error}`);
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
    const embeddings: number[][] = [];
    let totalTokens = 0;

    for (const text of texts) {
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

      embeddings.push(data.embedding.values);
      totalTokens += Math.ceil(text.length / 4);
    }

    return {
      embeddings,
      totalTokensUsed: totalTokens,
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
    const embeddings: number[][] = [];
    let totalTokens = 0;

    for (const text of texts) {
      const result = await this.embed(text);
      embeddings.push(result.embedding);
      totalTokens += result.tokensUsed;
    }

    return {
      embeddings,
      totalTokensUsed: totalTokens,
    };
  }

  getModelInfo(): EmbeddingModelInfo {
    return this.modelInfo;
  }
}
