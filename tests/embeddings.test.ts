import { describe, it, expect } from "vitest";
import { getProviderDisplayName, createCustomProviderInfo } from "../src/embeddings/detector.js";

describe("embeddings detector", () => {
  describe("getProviderDisplayName", () => {
    it("should return 'GitHub Copilot' for github-copilot", () => {
      expect(getProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
    });

    it("should return 'OpenAI' for openai", () => {
      expect(getProviderDisplayName("openai")).toBe("OpenAI");
    });

    it("should return 'Google (Gemini)' for google", () => {
      expect(getProviderDisplayName("google")).toBe("Google (Gemini)");
    });

    it("should return 'Ollama (Local)' for ollama", () => {
      expect(getProviderDisplayName("ollama")).toBe("Ollama (Local)");
    });

    it("should return the provider name as-is for unknown provider (default branch)", () => {
      // "auto" is no longer a valid EmbeddingProvider, but the default branch
      // still returns the input string for forward-compatibility
      expect(getProviderDisplayName("some-future-provider" as never)).toBe("some-future-provider");
    });

    it("should return 'Custom (OpenAI-compatible)' for custom", () => {
      expect(getProviderDisplayName("custom")).toBe("Custom (OpenAI-compatible)");
    });
  });

  describe("createCustomProviderInfo", () => {
    it("should create provider info with required fields", () => {
      const info = createCustomProviderInfo({
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        dimensions: 768,
      });
      expect(info.provider).toBe("custom");
      expect(info.credentials.provider).toBe("custom");
      expect(info.credentials.baseUrl).toBe("http://localhost:11434/v1");
      expect(info.credentials.apiKey).toBeUndefined();
      expect(info.modelInfo.provider).toBe("custom");
      expect(info.modelInfo.model).toBe("nomic-embed-text");
      expect(info.modelInfo.dimensions).toBe(768);
      expect(info.modelInfo.maxTokens).toBe(8192);
      expect(info.modelInfo.costPer1MTokens).toBe(0);
    });

    it("should pass through optional apiKey", () => {
      const info = createCustomProviderInfo({
        baseUrl: "https://api.example.com/v1",
        model: "my-model",
        dimensions: 1024,
        apiKey: "sk-test",
      });
      expect(info.credentials.apiKey).toBe("sk-test");
    });

    it("should use provided maxTokens", () => {
      const info = createCustomProviderInfo({
        baseUrl: "http://localhost/v1",
        model: "test",
        dimensions: 512,
        maxTokens: 4096,
      });
      expect(info.modelInfo.maxTokens).toBe(4096);
    });
  });
});
