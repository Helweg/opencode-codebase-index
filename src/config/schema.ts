// Config schema without zod dependency to avoid version conflicts with OpenCode SDK

import { DEFAULT_INCLUDE, DEFAULT_EXCLUDE, EMBEDDING_MODELS, DEFAULT_PROVIDER_MODELS } from "./constants.js";
import { substituteEnvString } from "./env-substitution.js";

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
  /** 
   * When true (default), requires a project marker (.git, package.json, Cargo.toml, etc.) 
   * to be present before enabling file watching and auto-indexing.
   * This prevents accidentally watching/indexing large non-project directories like home.
   * Set to false to allow indexing any directory.
   */
  requireProjectMarker: boolean;
}

export interface SearchConfig {
  maxResults: number;
  minScore: number;
  includeContext: boolean;
  hybridWeight: number;
  fusionStrategy: "weighted" | "rrf";
  rrfK: number;
  rerankTopN: number;
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

export interface CustomProviderConfig {
  /** Base URL of the OpenAI-compatible embeddings API. The path /embeddings is appended automatically (e.g. "http://localhost:11434/v1", "https://api.example.com/v1") */
  baseUrl: string;
  /** Model name to send in the API request (e.g. "nomic-embed-text") */
  model: string;
  /** Vector dimensions the model produces (e.g. 768 for nomic-embed-text) */
  dimensions: number;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Max tokens per input text (default: 8192) */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Max concurrent embedding requests (default: 3). Increase for local servers like llama.cpp or vLLM. */
  concurrency?: number;
  /** Minimum delay between requests in milliseconds (default: 1000). Set to 0 for local servers. */
  requestIntervalMs?: number;
}

export interface CodebaseIndexConfig {
  embeddingProvider: EmbeddingProvider | 'custom' | 'auto';
  embeddingModel?: EmbeddingModelName;
  /** Configuration for custom OpenAI-compatible embedding providers (required when embeddingProvider is 'custom') */
  customProvider?: CustomProviderConfig;
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
    requireProjectMarker: true,
  };
}

function getDefaultSearchConfig(): SearchConfig {
  return {
    maxResults: 20,
    minScore: 0.1,
    includeContext: true,
    hybridWeight: 0.5,
    fusionStrategy: "rrf",
    rrfK: 60,
    rerankTopN: 20,
    contextLines: 0,
  };
}

function isValidFusionStrategy(value: unknown): value is SearchConfig["fusionStrategy"] {
  return value === "weighted" || value === "rrf";
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

const VALID_SCOPES: IndexScope[] = ["project", "global"];
const VALID_LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

function isValidProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === "string" && Object.keys(EMBEDDING_MODELS).includes(value);
}

export function isValidModel<P extends EmbeddingProvider>(
  value: unknown,
  provider: P
): value is ProviderModels[P] {
  return typeof value === "string" && Object.keys(EMBEDDING_MODELS[provider]).includes(value);
}

function isValidScope(value: unknown): value is IndexScope {
  return typeof value === "string" && VALID_SCOPES.includes(value as IndexScope);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function getResolvedString(value: unknown, keyPath: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return substituteEnvString(value, keyPath);
}

function getResolvedStringArray(value: unknown, keyPath: string): string[] | undefined {
  if (!isStringArray(value)) {
    return undefined;
  }

  return value.map((item, index) => substituteEnvString(item, `${keyPath}[${index}]`));
}

function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevel);
}

export function parseConfig(raw: unknown): ParsedCodebaseIndexConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const embeddingProviderValue = getResolvedString(input.embeddingProvider, "$root.embeddingProvider");
  const scopeValue = getResolvedString(input.scope, "$root.scope");
  const includeValue = getResolvedStringArray(input.include, "$root.include");
  const excludeValue = getResolvedStringArray(input.exclude, "$root.exclude");

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
    requireProjectMarker: typeof rawIndexing.requireProjectMarker === "boolean" ? rawIndexing.requireProjectMarker : defaultIndexing.requireProjectMarker,
  };

  const rawSearch = (input.search && typeof input.search === "object" ? input.search : {}) as Record<string, unknown>;
  const search: SearchConfig = {
    maxResults: typeof rawSearch.maxResults === "number" ? rawSearch.maxResults : defaultSearch.maxResults,
    minScore: typeof rawSearch.minScore === "number" ? rawSearch.minScore : defaultSearch.minScore,
    includeContext: typeof rawSearch.includeContext === "boolean" ? rawSearch.includeContext : defaultSearch.includeContext,
    hybridWeight: typeof rawSearch.hybridWeight === "number" ? Math.min(1, Math.max(0, rawSearch.hybridWeight)) : defaultSearch.hybridWeight,
    fusionStrategy: isValidFusionStrategy(rawSearch.fusionStrategy) ? rawSearch.fusionStrategy : defaultSearch.fusionStrategy,
    rrfK: typeof rawSearch.rrfK === "number" ? Math.max(1, Math.floor(rawSearch.rrfK)) : defaultSearch.rrfK,
    rerankTopN: typeof rawSearch.rerankTopN === "number" ? Math.min(200, Math.max(0, Math.floor(rawSearch.rerankTopN))) : defaultSearch.rerankTopN,
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

  let embeddingProvider: EmbeddingProvider | 'custom' | 'auto';
  let embeddingModel: EmbeddingModelName | undefined = undefined;
  let customProvider: CustomProviderConfig | undefined = undefined;
  
  if (embeddingProviderValue === 'custom') {
    embeddingProvider = 'custom';
    const rawCustom = (input.customProvider && typeof input.customProvider === 'object' ? input.customProvider : null) as Record<string, unknown> | null;
    const baseUrlValue = getResolvedString(rawCustom?.baseUrl, "$root.customProvider.baseUrl");
    const modelValue = getResolvedString(rawCustom?.model, "$root.customProvider.model");
    const apiKeyValue = getResolvedString(rawCustom?.apiKey, "$root.customProvider.apiKey");
    if (rawCustom && typeof baseUrlValue === 'string' && baseUrlValue.trim().length > 0 && typeof modelValue === 'string' && modelValue.trim().length > 0 && typeof rawCustom.dimensions === 'number' && Number.isInteger(rawCustom.dimensions) && rawCustom.dimensions > 0) {
      customProvider = {
        baseUrl: baseUrlValue.trim().replace(/\/+$/, ''),
        model: modelValue,
        dimensions: rawCustom.dimensions,
        apiKey: apiKeyValue,
        maxTokens: typeof rawCustom.maxTokens === 'number' ? rawCustom.maxTokens : undefined,
        timeoutMs: typeof rawCustom.timeoutMs === 'number' ? Math.max(1000, rawCustom.timeoutMs) : undefined,
        concurrency: typeof rawCustom.concurrency === 'number' ? Math.max(1, Math.floor(rawCustom.concurrency)) : undefined,
        requestIntervalMs: typeof rawCustom.requestIntervalMs === 'number' ? Math.max(0, Math.floor(rawCustom.requestIntervalMs)) : undefined,
      };
      // Warn if baseUrl doesn't end with an API version path like /v1.
      // Note: using console.warn here because Logger isn't initialized yet at config parse time.
      if (!/\/v\d+\/?$/.test(customProvider.baseUrl)) {
        console.warn(
          `[codebase-index] Warning: customProvider.baseUrl ("${customProvider.baseUrl}") does not end with an API version path like /v1. ` +
          `The plugin appends /embeddings automatically, so the full URL will be "${customProvider.baseUrl}/embeddings". ` +
          `If your provider expects /v1/embeddings, set baseUrl to "${customProvider.baseUrl}/v1".`
        );
      }
    } else {
      throw new Error(
        "embeddingProvider is 'custom' but customProvider config is missing or invalid. " +
        "Required fields: baseUrl (string), model (string), dimensions (positive integer)."
      );
    }
  } else if (isValidProvider(embeddingProviderValue)) {
    embeddingProvider = embeddingProviderValue;
    const rawEmbeddingModel = input.embeddingModel;
    if (typeof rawEmbeddingModel === "string") {
      const embeddingModelValue = substituteEnvString(rawEmbeddingModel, "$root.embeddingModel");
      if (embeddingModelValue) {
        embeddingModel = isValidModel(embeddingModelValue, embeddingProvider) ? embeddingModelValue : DEFAULT_PROVIDER_MODELS[embeddingProvider];
      }
    } else if (rawEmbeddingModel) {
      embeddingModel = DEFAULT_PROVIDER_MODELS[embeddingProvider];
    }
  } else {
    embeddingProvider = 'auto';
  }

  return {
    embeddingProvider,
    embeddingModel,
    customProvider,
    scope: isValidScope(scopeValue) ? scopeValue : "project",
    include: includeValue ?? DEFAULT_INCLUDE,
    exclude: excludeValue ?? DEFAULT_EXCLUDE,
    indexing,
    search,
    debug,
  };
}

export function getDefaultModelForProvider(provider: EmbeddingProvider): EmbeddingModelInfo {
  const models = EMBEDDING_MODELS[provider]
  const providerDefault = DEFAULT_PROVIDER_MODELS[provider]
  return models[providerDefault as keyof typeof models]
}

/**
 * Built-in embedding providers derived from the static EMBEDDING_MODELS catalog.
 * 'custom' is intentionally excluded from this union because it has no static model
 * catalog — its model/dimensions/config are entirely user-defined at runtime via
 * CustomProviderConfig. Code that handles all providers uses `EmbeddingProvider | 'custom'`.
 */
export type EmbeddingProvider = keyof typeof EMBEDDING_MODELS;

export const availableProviders: EmbeddingProvider[] = Object.keys(EMBEDDING_MODELS) as EmbeddingProvider[]

export type ProviderModels = {
  [P in keyof typeof EMBEDDING_MODELS]: keyof (typeof EMBEDDING_MODELS)[P]
}

export type EmbeddingModelName = ProviderModels[keyof ProviderModels]

export type EmbeddingProviderModelInfo = {
  [P in EmbeddingProvider]: (typeof EMBEDDING_MODELS)[P][keyof (typeof EMBEDDING_MODELS)[P]]
}


/** Shared fields across all embedding model types (built-in and custom) */
export interface BaseModelInfo {
  model: string;
  dimensions: number;
  maxTokens: number;
  costPer1MTokens: number;
}

export type EmbeddingModelInfo = EmbeddingProviderModelInfo[EmbeddingProvider]
