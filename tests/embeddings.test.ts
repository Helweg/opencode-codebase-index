import { describe, it, expect } from "vitest";
import { getProviderDisplayName } from "../src/embeddings/detector.js";

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
  });
});
