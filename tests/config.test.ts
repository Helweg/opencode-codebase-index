import { describe, it, expect } from "vitest";
import {
  parseConfig,
  getDefaultConfig,
  getDefaultModelForProvider,
  EMBEDDING_MODELS,
} from "../src/config/schema.js";

describe("config schema", () => {
  describe("parseConfig", () => {
    it("should return defaults for undefined input", () => {
      const config = parseConfig(undefined);

      expect(config.embeddingProvider).toBe("auto");
      expect(config.embeddingModel).toBe("auto");
      expect(config.scope).toBe("project");
      expect(config.include).toHaveLength(10);
      expect(config.exclude).toHaveLength(13);
    });

    it("should return defaults for null input", () => {
      const config = parseConfig(null);

      expect(config.embeddingProvider).toBe("auto");
      expect(config.indexing.autoIndex).toBe(false);
    });

    it("should return defaults for non-object input", () => {
      expect(parseConfig("string").embeddingProvider).toBe("auto");
      expect(parseConfig(123).embeddingProvider).toBe("auto");
      expect(parseConfig([]).embeddingProvider).toBe("auto");
    });

    it("should parse valid embeddingProvider values", () => {
      expect(parseConfig({ embeddingProvider: "openai" }).embeddingProvider).toBe("openai");
      expect(parseConfig({ embeddingProvider: "google" }).embeddingProvider).toBe("google");
      expect(parseConfig({ embeddingProvider: "ollama" }).embeddingProvider).toBe("ollama");
      expect(parseConfig({ embeddingProvider: "github-copilot" }).embeddingProvider).toBe("github-copilot");
      expect(parseConfig({ embeddingProvider: "auto" }).embeddingProvider).toBe("auto");
    });

    it("should fallback to auto for invalid embeddingProvider", () => {
      expect(parseConfig({ embeddingProvider: "invalid" }).embeddingProvider).toBe("auto");
      expect(parseConfig({ embeddingProvider: 123 }).embeddingProvider).toBe("auto");
      expect(parseConfig({ embeddingProvider: null }).embeddingProvider).toBe("auto");
    });

    it("should parse valid scope values", () => {
      expect(parseConfig({ scope: "project" }).scope).toBe("project");
      expect(parseConfig({ scope: "global" }).scope).toBe("global");
    });

    it("should fallback to project for invalid scope", () => {
      expect(parseConfig({ scope: "invalid" }).scope).toBe("project");
      expect(parseConfig({ scope: 123 }).scope).toBe("project");
    });

    it("should parse embeddingModel as string", () => {
      expect(parseConfig({ embeddingModel: "custom-model" }).embeddingModel).toBe("custom-model");
    });

    it("should fallback to auto for non-string embeddingModel", () => {
      expect(parseConfig({ embeddingModel: 123 }).embeddingModel).toBe("auto");
      expect(parseConfig({ embeddingModel: null }).embeddingModel).toBe("auto");
    });

    it("should parse include as string array", () => {
      const config = parseConfig({ include: ["**/*.ts", "**/*.js"] });
      expect(config.include).toEqual(["**/*.ts", "**/*.js"]);
    });

    it("should fallback to defaults for non-array include", () => {
      expect(parseConfig({ include: "string" }).include).toHaveLength(10);
      expect(parseConfig({ include: 123 }).include).toHaveLength(10);
    });

    it("should fallback to defaults for include with non-string items", () => {
      expect(parseConfig({ include: [123, 456] }).include).toHaveLength(10);
      expect(parseConfig({ include: ["valid", 123] }).include).toHaveLength(10);
    });

    it("should parse exclude as string array", () => {
      const config = parseConfig({ exclude: ["**/node_modules/**"] });
      expect(config.exclude).toEqual(["**/node_modules/**"]);
    });

    describe("indexing config", () => {
      it("should parse boolean indexing options", () => {
        const config = parseConfig({
          indexing: {
            autoIndex: true,
            watchFiles: false,
            semanticOnly: true,
            autoGc: false,
          },
        });

        expect(config.indexing.autoIndex).toBe(true);
        expect(config.indexing.watchFiles).toBe(false);
        expect(config.indexing.semanticOnly).toBe(true);
        expect(config.indexing.autoGc).toBe(false);
      });

      it("should fallback to defaults for non-boolean indexing options", () => {
        const config = parseConfig({
          indexing: {
            autoIndex: "true",
            watchFiles: 1,
          },
        });

        expect(config.indexing.autoIndex).toBe(false);
        expect(config.indexing.watchFiles).toBe(true);
      });

      it("should parse numeric indexing options", () => {
        const config = parseConfig({
          indexing: {
            maxFileSize: 2000000,
            maxChunksPerFile: 50,
            retries: 5,
            retryDelayMs: 2000,
            gcIntervalDays: 14,
            gcOrphanThreshold: 200,
          },
        });

        expect(config.indexing.maxFileSize).toBe(2000000);
        expect(config.indexing.maxChunksPerFile).toBe(50);
        expect(config.indexing.retries).toBe(5);
        expect(config.indexing.retryDelayMs).toBe(2000);
        expect(config.indexing.gcIntervalDays).toBe(14);
        expect(config.indexing.gcOrphanThreshold).toBe(200);
      });

      it("should enforce minimum of 1 for maxChunksPerFile", () => {
        expect(parseConfig({ indexing: { maxChunksPerFile: 0 } }).indexing.maxChunksPerFile).toBe(1);
        expect(parseConfig({ indexing: { maxChunksPerFile: -5 } }).indexing.maxChunksPerFile).toBe(1);
      });

      it("should enforce minimum of 1 for gcIntervalDays", () => {
        expect(parseConfig({ indexing: { gcIntervalDays: 0 } }).indexing.gcIntervalDays).toBe(1);
        expect(parseConfig({ indexing: { gcIntervalDays: -1 } }).indexing.gcIntervalDays).toBe(1);
      });

      it("should enforce minimum of 0 for gcOrphanThreshold", () => {
        expect(parseConfig({ indexing: { gcOrphanThreshold: -10 } }).indexing.gcOrphanThreshold).toBe(0);
      });

      it("should handle non-object indexing", () => {
        expect(parseConfig({ indexing: "invalid" }).indexing.autoIndex).toBe(false);
        expect(parseConfig({ indexing: null }).indexing.autoIndex).toBe(false);
      });
    });

    describe("search config", () => {
      it("should parse search options", () => {
        const config = parseConfig({
          search: {
            maxResults: 50,
            minScore: 0.2,
            includeContext: false,
            hybridWeight: 0.7,
            contextLines: 10,
          },
        });

        expect(config.search.maxResults).toBe(50);
        expect(config.search.minScore).toBe(0.2);
        expect(config.search.includeContext).toBe(false);
        expect(config.search.hybridWeight).toBe(0.7);
        expect(config.search.contextLines).toBe(10);
      });

      it("should clamp hybridWeight to 0-1 range", () => {
        expect(parseConfig({ search: { hybridWeight: -0.5 } }).search.hybridWeight).toBe(0);
        expect(parseConfig({ search: { hybridWeight: 1.5 } }).search.hybridWeight).toBe(1);
        expect(parseConfig({ search: { hybridWeight: 0.5 } }).search.hybridWeight).toBe(0.5);
      });

      it("should clamp contextLines to 0-50 range", () => {
        expect(parseConfig({ search: { contextLines: -5 } }).search.contextLines).toBe(0);
        expect(parseConfig({ search: { contextLines: 100 } }).search.contextLines).toBe(50);
        expect(parseConfig({ search: { contextLines: 25 } }).search.contextLines).toBe(25);
      });

      it("should handle non-object search", () => {
        expect(parseConfig({ search: "invalid" }).search.maxResults).toBe(20);
      });
    });
  });

  describe("getDefaultConfig", () => {
    it("should return expected default values", () => {
      const config = getDefaultConfig();

      expect(config.embeddingProvider).toBe("auto");
      expect(config.embeddingModel).toBe("auto");
      expect(config.scope).toBe("project");
      expect(config.include).toContain("**/*.{ts,tsx,js,jsx,mjs,cjs}");
      expect(config.exclude).toContain("**/node_modules/**");
    });
  });

  describe("getDefaultModelForProvider", () => {
    it("should return correct model for github-copilot", () => {
      const model = getDefaultModelForProvider("github-copilot");
      expect(model.provider).toBe("github-copilot");
      expect(model.model).toBe("text-embedding-3-small");
      expect(model.dimensions).toBe(1536);
    });

    it("should return correct model for openai", () => {
      const model = getDefaultModelForProvider("openai");
      expect(model.provider).toBe("openai");
      expect(model.model).toBe("text-embedding-3-small");
    });

    it("should return correct model for google", () => {
      const model = getDefaultModelForProvider("google");
      expect(model.provider).toBe("google");
      expect(model.model).toBe("text-embedding-004");
      expect(model.dimensions).toBe(768);
    });

    it("should return correct model for ollama", () => {
      const model = getDefaultModelForProvider("ollama");
      expect(model.provider).toBe("ollama");
      expect(model.model).toBe("nomic-embed-text");
    });

    it("should return github-copilot model for auto (default case)", () => {
      const model = getDefaultModelForProvider("auto");
      expect(model.provider).toBe("github-copilot");
    });
  });

  describe("EMBEDDING_MODELS", () => {
    it("should have expected models defined", () => {
      expect(EMBEDDING_MODELS).toHaveProperty("github-copilot/text-embedding-3-small");
      expect(EMBEDDING_MODELS).toHaveProperty("openai/text-embedding-3-small");
      expect(EMBEDDING_MODELS).toHaveProperty("openai/text-embedding-3-large");
      expect(EMBEDDING_MODELS).toHaveProperty("google/text-embedding-004");
      expect(EMBEDDING_MODELS).toHaveProperty("ollama/nomic-embed-text");
      expect(EMBEDDING_MODELS).toHaveProperty("ollama/mxbai-embed-large");
    });

    it("should have correct cost for free providers", () => {
      expect(EMBEDDING_MODELS["github-copilot/text-embedding-3-small"].costPer1MTokens).toBe(0);
      expect(EMBEDDING_MODELS["google/text-embedding-004"].costPer1MTokens).toBe(0);
      expect(EMBEDDING_MODELS["ollama/nomic-embed-text"].costPer1MTokens).toBe(0);
    });

    it("should have non-zero cost for paid providers", () => {
      expect(EMBEDDING_MODELS["openai/text-embedding-3-small"].costPer1MTokens).toBeGreaterThan(0);
      expect(EMBEDDING_MODELS["openai/text-embedding-3-large"].costPer1MTokens).toBeGreaterThan(0);
    });
  });
});
