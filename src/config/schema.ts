// Config schema without zod dependency to avoid version conflicts with OpenCode SDK

import { DEFAULT_INCLUDE, DEFAULT_EXCLUDE, EMBEDDING_MODELS, DEFAULT_PROVIDER_MODELS } from "./constants.js";

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
  embeddingProvider: EmbeddingProvider | 'auto';
  embeddingModel?: EmbeddingModelName;
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
    requireProjectMarker: typeof rawIndexing.requireProjectMarker === "boolean" ? rawIndexing.requireProjectMarker : defaultIndexing.requireProjectMarker,
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

  let embeddingProvider: EmbeddingProvider | 'auto';
  let embeddingModel: EmbeddingModelName | undefined = undefined;
  
  if (isValidProvider(input.embeddingProvider)) {
    embeddingProvider = input.embeddingProvider;
    if (input.embeddingModel) {
      embeddingModel = isValidModel(input.embeddingModel, embeddingProvider) ? input.embeddingModel : DEFAULT_PROVIDER_MODELS[embeddingProvider];
    }
  } else {
    embeddingProvider = 'auto';
  }

  return {
    embeddingProvider,
    embeddingModel,
    scope: isValidScope(input.scope) ? input.scope : "project",
    include: isStringArray(input.include) ? input.include : DEFAULT_INCLUDE,
    exclude: isStringArray(input.exclude) ? input.exclude : DEFAULT_EXCLUDE,
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

export type EmbeddingProvider = keyof typeof EMBEDDING_MODELS;

export const availableProviders: EmbeddingProvider[] = Object.keys(EMBEDDING_MODELS) as EmbeddingProvider[]

export type ProviderModels = {
  [P in keyof typeof EMBEDDING_MODELS]: keyof (typeof EMBEDDING_MODELS)[P]
}

export type EmbeddingModelName = ProviderModels[keyof ProviderModels]

export type EmbeddingProviderModelInfo = {
  [P in EmbeddingProvider]: (typeof EMBEDDING_MODELS)[P][keyof (typeof EMBEDDING_MODELS)[P]]
}

export type EmbeddingModelInfo = EmbeddingProviderModelInfo[EmbeddingProvider]
