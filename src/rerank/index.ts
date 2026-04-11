import { RerankerConfig } from "../config/schema.js";

export interface RerankResult {
  index: number;
  relevanceScore: number;
  document?: string;
}

export interface RerankResponse {
  results: RerankResult[];
  tokensUsed?: number;
}

export interface RerankerInterface {
  isAvailable(): boolean;
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResponse>;
}

export function createReranker(config: RerankerConfig): RerankerInterface {
  if (!config.enabled) {
    return new NoOpReranker();
  }
  return new SiliconFlowReranker(config);
}

class NoOpReranker implements RerankerInterface {
  isAvailable(): boolean {
    return false;
  }

  async rerank(_query: string, documents: string[], _topN?: number): Promise<RerankResponse> {
    return {
      results: documents.map((_, index) => ({ index, relevanceScore: 0 })),
    };
  }
}

class SiliconFlowReranker implements RerankerInterface {
  private config: RerankerConfig;

  constructor(config: RerankerConfig) {
    this.config = config;
  }

  isAvailable(): boolean {
    return this.config.enabled && !!this.config.baseUrl && !!this.config.model;
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResponse> {
    if (documents.length === 0) {
      return { results: [] };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const baseUrl = this.config.baseUrl ?? "https://api.siliconflow.cn/v1";
    const timeoutMs = this.config.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/rerank`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          query,
          documents,
          top_n: topN ?? this.config.topN ?? 20,
          return_documents: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Rerank API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        results: Array<{
          index: number;
          relevance_score: number;
          document?: { text: string };
        }>;
        meta?: {
          tokens?: {
            input_tokens: number;
            output_tokens: number;
          };
        };
      };

      return {
        results: data.results.map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score,
          document: r.document?.text,
        })),
        tokensUsed: data.meta?.tokens?.input_tokens,
      };
    } catch (error: unknown) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Rerank API request timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }
}
