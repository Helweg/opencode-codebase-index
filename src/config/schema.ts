// Config schema without zod dependency to avoid version conflicts with OpenCode SDK

export type EmbeddingProvider = "auto" | "github-copilot" | "openai" | "google" | "ollama";

export type IndexScope = "project" | "global";

export interface IndexingConfig {
  autoIndex: boolean;
  watchFiles: boolean;
  maxFileSize: number;
  maxChunksPerFile: number;
  semanticOnly: boolean;
  retries: number;
  retryDelayMs: number;
  autoGc: boolean;
  gcIntervalDays: number;
  gcOrphanThreshold: number;
}

export interface SearchConfig {
  maxResults: number;
  minScore: number;
  includeContext: boolean;
  hybridWeight: number;
  contextLines: number;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface DebugConfig {
  enabled: boolean;
  logLevel: LogLevel;
  logSearch: boolean;
  logEmbedding: boolean;
  logCache: boolean;
  logGc: boolean;
  logBranch: boolean;
  metrics: boolean;
}

export interface CodebaseIndexConfig {
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  scope: IndexScope;
  indexing?: Partial<IndexingConfig>;
  search?: Partial<SearchConfig>;
  debug?: Partial<DebugConfig>;
  include: string[];
  exclude: string[];
}

export type ParsedCodebaseIndexConfig = CodebaseIndexConfig & {
  indexing: IndexingConfig;
  search: SearchConfig;
  debug: DebugConfig;
};

const DEFAULT_INCLUDE = [
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
];

const DEFAULT_EXCLUDE = [
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
];

function getDefaultIndexingConfig(): IndexingConfig {
  return {
    autoIndex: false,
    watchFiles: true,
    maxFileSize: 1048576,
    maxChunksPerFile: 100,
    semanticOnly: false,
    retries: 3,
    retryDelayMs: 1000,
    autoGc: true,
    gcIntervalDays: 7,
    gcOrphanThreshold: 100,
  };
}

function getDefaultSearchConfig(): SearchConfig {
  return {
    maxResults: 20,
    minScore: 0.1,
    includeContext: true,
    hybridWeight: 0.5,
    contextLines: 0,
  };
}

function getDefaultDebugConfig(): DebugConfig {
  return {
    enabled: false,
    logLevel: "info",
    logSearch: true,
    logEmbedding: true,
    logCache: true,
    logGc: true,
    logBranch: true,
    metrics: true,
  };
}

const VALID_PROVIDERS: EmbeddingProvider[] = ["auto", "github-copilot", "openai", "google", "ollama"];
const VALID_SCOPES: IndexScope[] = ["project", "global"];
const VALID_LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

function isValidProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === "string" && VALID_PROVIDERS.includes(value as EmbeddingProvider);
}

function isValidScope(value: unknown): value is IndexScope {
  return typeof value === "string" && VALID_SCOPES.includes(value as IndexScope);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevel);
}

export function parseConfig(raw: unknown): ParsedCodebaseIndexConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  
  const defaultIndexing = getDefaultIndexingConfig();
  const defaultSearch = getDefaultSearchConfig();
  const defaultDebug = getDefaultDebugConfig();
  
  const rawIndexing = (input.indexing && typeof input.indexing === "object" ? input.indexing : {}) as Record<string, unknown>;
  const indexing: IndexingConfig = {
    autoIndex: typeof rawIndexing.autoIndex === "boolean" ? rawIndexing.autoIndex : defaultIndexing.autoIndex,
    watchFiles: typeof rawIndexing.watchFiles === "boolean" ? rawIndexing.watchFiles : defaultIndexing.watchFiles,
    maxFileSize: typeof rawIndexing.maxFileSize === "number" ? rawIndexing.maxFileSize : defaultIndexing.maxFileSize,
    maxChunksPerFile: typeof rawIndexing.maxChunksPerFile === "number" ? Math.max(1, rawIndexing.maxChunksPerFile) : defaultIndexing.maxChunksPerFile,
    semanticOnly: typeof rawIndexing.semanticOnly === "boolean" ? rawIndexing.semanticOnly : defaultIndexing.semanticOnly,
    retries: typeof rawIndexing.retries === "number" ? rawIndexing.retries : defaultIndexing.retries,
    retryDelayMs: typeof rawIndexing.retryDelayMs === "number" ? rawIndexing.retryDelayMs : defaultIndexing.retryDelayMs,
    autoGc: typeof rawIndexing.autoGc === "boolean" ? rawIndexing.autoGc : defaultIndexing.autoGc,
    gcIntervalDays: typeof rawIndexing.gcIntervalDays === "number" ? Math.max(1, rawIndexing.gcIntervalDays) : defaultIndexing.gcIntervalDays,
    gcOrphanThreshold: typeof rawIndexing.gcOrphanThreshold === "number" ? Math.max(0, rawIndexing.gcOrphanThreshold) : defaultIndexing.gcOrphanThreshold,
  };
  
  const rawSearch = (input.search && typeof input.search === "object" ? input.search : {}) as Record<string, unknown>;
  const search: SearchConfig = {
    maxResults: typeof rawSearch.maxResults === "number" ? rawSearch.maxResults : defaultSearch.maxResults,
    minScore: typeof rawSearch.minScore === "number" ? rawSearch.minScore : defaultSearch.minScore,
    includeContext: typeof rawSearch.includeContext === "boolean" ? rawSearch.includeContext : defaultSearch.includeContext,
    hybridWeight: typeof rawSearch.hybridWeight === "number" ? Math.min(1, Math.max(0, rawSearch.hybridWeight)) : defaultSearch.hybridWeight,
    contextLines: typeof rawSearch.contextLines === "number" ? Math.min(50, Math.max(0, rawSearch.contextLines)) : defaultSearch.contextLines,
  };
  
  const rawDebug = (input.debug && typeof input.debug === "object" ? input.debug : {}) as Record<string, unknown>;
  const debug: DebugConfig = {
    enabled: typeof rawDebug.enabled === "boolean" ? rawDebug.enabled : defaultDebug.enabled,
    logLevel: isValidLogLevel(rawDebug.logLevel) ? rawDebug.logLevel : defaultDebug.logLevel,
    logSearch: typeof rawDebug.logSearch === "boolean" ? rawDebug.logSearch : defaultDebug.logSearch,
    logEmbedding: typeof rawDebug.logEmbedding === "boolean" ? rawDebug.logEmbedding : defaultDebug.logEmbedding,
    logCache: typeof rawDebug.logCache === "boolean" ? rawDebug.logCache : defaultDebug.logCache,
    logGc: typeof rawDebug.logGc === "boolean" ? rawDebug.logGc : defaultDebug.logGc,
    logBranch: typeof rawDebug.logBranch === "boolean" ? rawDebug.logBranch : defaultDebug.logBranch,
    metrics: typeof rawDebug.metrics === "boolean" ? rawDebug.metrics : defaultDebug.metrics,
  };
  
  return {
    embeddingProvider: isValidProvider(input.embeddingProvider) ? input.embeddingProvider : "auto",
    embeddingModel: typeof input.embeddingModel === "string" ? input.embeddingModel : "auto",
    scope: isValidScope(input.scope) ? input.scope : "project",
    include: isStringArray(input.include) ? input.include : DEFAULT_INCLUDE,
    exclude: isStringArray(input.exclude) ? input.exclude : DEFAULT_EXCLUDE,
    indexing,
    search,
    debug,
  };
}

export function getDefaultConfig(): CodebaseIndexConfig {
  return {
    embeddingProvider: "auto",
    embeddingModel: "auto",
    scope: "project",
    include: DEFAULT_INCLUDE,
    exclude: DEFAULT_EXCLUDE,
  };
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
      return EMBEDDING_MODELS["github-copilot/text-embedding-3-small"];
  }
}
