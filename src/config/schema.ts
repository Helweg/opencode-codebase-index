import { z } from "zod";

export const EmbeddingProviderSchema = z.enum([
  "auto",
  "github-copilot",
  "openai",
  "google",
  "ollama",
]);

export type EmbeddingProvider = z.infer<typeof EmbeddingProviderSchema>;

export const IndexScopeSchema = z.enum(["project", "global"]);

export type IndexScope = z.infer<typeof IndexScopeSchema>;

export const IndexingConfigSchema = z.object({
  autoIndex: z.boolean().default(false),
  watchFiles: z.boolean().default(true),
  confirmBeforeIndex: z.boolean().default(true),
  maxFileSize: z.number().default(1048576),
  batchSize: z.number().default(10),
  retries: z.number().default(3),
  retryDelayMs: z.number().default(1000),
});

export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;

export const SearchConfigSchema = z.object({
  maxResults: z.number().default(20),
  minScore: z.number().default(0.1),
  includeContext: z.boolean().default(true),
});

export type SearchConfig = z.infer<typeof SearchConfigSchema>;

export const StorageConfigSchema = z.object({
  location: IndexScopeSchema.default("project"),
});

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const CodebaseIndexConfigSchema = z.object({
  embeddingProvider: EmbeddingProviderSchema.default("auto"),
  embeddingModel: z.string().default("auto"),
  scope: IndexScopeSchema.default("project"),
  
  indexing: IndexingConfigSchema.optional(),
  search: SearchConfigSchema.optional(),
  storage: StorageConfigSchema.optional(),

  include: z.array(z.string()).default([
    "**/*.{ts,tsx,js,jsx,mjs,cjs}",
    "**/*.{py,pyi}",
    "**/*.{go,rs,java,kt,scala}",
    "**/*.{c,cpp,cc,h,hpp}",
    "**/*.{rb,php,swift}",
    "**/*.{vue,svelte,astro}",
    "**/*.{sql,graphql,proto}",
    "**/*.{yaml,yml,toml}",
    "**/*.{md,mdx}",
    "**/*.{sh,bash,zsh}",
  ]),

  exclude: z.array(z.string()).default([
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/*.min.js",
    "**/*.bundle.js",
    "**/vendor/**",
    "**/__pycache__/**",
    "**/target/**",
    "**/coverage/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.opencode/**",
  ]),
});

export type CodebaseIndexConfig = z.infer<typeof CodebaseIndexConfigSchema>;

function getDefaultIndexingConfig(): IndexingConfig {
  return {
    autoIndex: false,
    watchFiles: true,
    confirmBeforeIndex: true,
    maxFileSize: 1048576,
    batchSize: 10,
    retries: 3,
    retryDelayMs: 1000,
  };
}

function getDefaultSearchConfig(): SearchConfig {
  return {
    maxResults: 20,
    minScore: 0.1,
    includeContext: true,
  };
}

function getDefaultStorageConfig(): StorageConfig {
  return {
    location: "project",
  };
}

export function parseConfig(raw: unknown): CodebaseIndexConfig & {
  indexing: IndexingConfig;
  search: SearchConfig;
  storage: StorageConfig;
} {
  const parsed = CodebaseIndexConfigSchema.parse(raw ?? {});
  return {
    ...parsed,
    indexing: parsed.indexing ?? getDefaultIndexingConfig(),
    search: parsed.search ?? getDefaultSearchConfig(),
    storage: parsed.storage ?? getDefaultStorageConfig(),
  };
}

export function getDefaultConfig(): CodebaseIndexConfig {
  return CodebaseIndexConfigSchema.parse({});
}

export interface EmbeddingModelInfo {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  maxTokens: number;
  costPer1MTokens: number;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelInfo> = {
  "github-copilot/text-embedding-3-small": {
    provider: "github-copilot",
    model: "text-embedding-3-small",
    dimensions: 1536,
    maxTokens: 8191,
    costPer1MTokens: 0.00,
  },
  "openai/text-embedding-3-small": {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    maxTokens: 8191,
    costPer1MTokens: 0.02,
  },
  "openai/text-embedding-3-large": {
    provider: "openai",
    model: "text-embedding-3-large",
    dimensions: 3072,
    maxTokens: 8191,
    costPer1MTokens: 0.13,
  },
  "google/text-embedding-004": {
    provider: "google",
    model: "text-embedding-004",
    dimensions: 768,
    maxTokens: 2048,
    costPer1MTokens: 0.00,
  },
  "ollama/nomic-embed-text": {
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
    maxTokens: 8192,
    costPer1MTokens: 0.00,
  },
  "ollama/mxbai-embed-large": {
    provider: "ollama",
    model: "mxbai-embed-large",
    dimensions: 1024,
    maxTokens: 512,
    costPer1MTokens: 0.00,
  },
};

export function getDefaultModelForProvider(provider: EmbeddingProvider): EmbeddingModelInfo {
  switch (provider) {
    case "github-copilot":
      return EMBEDDING_MODELS["github-copilot/text-embedding-3-small"];
    case "openai":
      return EMBEDDING_MODELS["openai/text-embedding-3-small"];
    case "google":
      return EMBEDDING_MODELS["google/text-embedding-004"];
    case "ollama":
      return EMBEDDING_MODELS["ollama/nomic-embed-text"];
    default:
      return EMBEDDING_MODELS["github/text-embedding-3-small"];
  }
}
