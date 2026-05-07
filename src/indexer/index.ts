import { existsSync, readFileSync, writeFileSync, unlinkSync, promises as fsPromises } from "fs";
import { createHash } from "crypto";
import * as path from "path";
import { performance } from "perf_hooks";
import PQueue from "p-queue";
import pRetry from "p-retry";

import { ParsedCodebaseIndexConfig, type RerankerConfig } from "../config/schema.js";
import { detectEmbeddingProvider, ConfiguredProviderInfo, tryDetectProvider, createCustomProviderInfo } from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
  CustomProviderNonRetryableError,
} from "../embeddings/provider.js";
import { createReranker, RerankerInterface } from "../rerank/index.js";
import { collectFiles, SkippedFile } from "../utils/files.js";
import { createCostEstimate, CostEstimate } from "../utils/cost.js";
import { Logger, initializeLogger } from "../utils/logger.js";
import {
  InvertedIndex,
  parseFiles,
  createEmbeddingTexts,
  generateChunkId,
  generateChunkHash,
  ChunkMetadata,
  ChunkData,
  createDynamicBatches,
  hashFile,
  hashContent,
  extractCalls,
  parseFileAsText,
  estimateTokens,
} from "../native/index.js";
import type { SymbolData, CallEdgeData } from "../native/index.js";
import type { IDatabaseBackend, IVectorStoreBackend } from "../db/index.js";
import { createDatabaseBackend, createVectorStoreBackend } from "../db/index.js";
import { getBranchOrDefault, getBaseBranch, isGitRepo } from "../git/index.js";
import { resolveProjectIndexPath } from "../config/paths.js";

export const CALL_GRAPH_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "php", "apex"]);
// Languages whose identifiers are case-insensitive at the language level.
// The Rust call_extractor lowercases callee names for these languages (except
// constructors and imports), so same-file resolution in this file must use
// the same normalization when looking up symbols by name. Keep this set in
// sync with the matching branch in native/src/call_extractor.rs.
export const CASE_INSENSITIVE_LANGUAGES = new Set(["apex"]);
export const CALL_GRAPH_SYMBOL_CHUNK_TYPES = new Set([
  "function_declaration",
  "function",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "function_definition",
  "class_definition",
  "decorated_definition",
  "method_declaration",
  "type_declaration",
  "type_spec",
  "function_item",
  "impl_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "mod_item",
  "trait_declaration",
  "trigger_declaration",
]);

function float32ArrayToBuffer(arr: number[]): Buffer {
  const float32 = new Float32Array(arr);
  return Buffer.from(float32.buffer);
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes("429") || message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("too many requests");
}

function getSafeEmbeddingChunkTokenLimit(provider: ConfiguredProviderInfo): number {
  const providerMaxTokens = provider.modelInfo.maxTokens;
  const maxChunkTokens = Math.max(256, Math.floor(providerMaxTokens * 0.75));
  return Math.min(2000, maxChunkTokens);
}

function getDynamicBatchOptions(provider: ConfiguredProviderInfo): { maxBatchTokens?: number; maxBatchItems?: number } {
  if (provider.provider === "ollama") {
    return {
      maxBatchTokens: provider.modelInfo.maxTokens,
      maxBatchItems: 1,
    };
  }

  return {};
}

function isSqliteCorruptionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("database disk image is malformed")
    || message.includes("file is not a database")
    || message.includes("database schema is corrupt")
    || message.includes("sqlite_corrupt");
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  durationMs: number;
  existingChunks: number;
  removedChunks: number;
  skippedFiles: SkippedFile[];
  parseFailures: string[];
  failedBatchesPath?: string;
  warning?: string;
  resetCorruptedIndex?: boolean;
}

interface CorruptedIndexResetResult {
  warning: string;
  resetCorruptedIndex: true;
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  chunkType: string;
  name?: string;
}

export interface HealthCheckResult {
  removed: number;
  filePaths: string[];
  gcOrphanEmbeddings: number;
  gcOrphanChunks: number;
  gcOrphanSymbols: number;
  gcOrphanCallEdges: number;
  warning?: string;
  resetCorruptedIndex?: boolean;
}

export interface StatusResult {
  indexed: boolean;
  vectorCount: number;
  provider: string;
  model: string;
  indexPath: string;
  currentBranch: string;
  baseBranch: string;
  compatibility: IndexCompatibility | null;
  failedBatchesCount: number;
  failedBatchesPath?: string;
  warning?: string;
  indexingInProgress: boolean;
  progress?: IndexProgress;
}

const STARTUP_WARNING_METADATA_KEY = "index.startupWarning";
const PROGRESS_SNAPSHOT_KEY = "index.progressSnapshot";

export interface IndexProgress {
  phase: "scanning" | "parsing" | "embedding" | "storing" | "complete";
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  currentFiles?: string[];
  /** True on the progress update emitted before a batch starts; false/absent on the one emitted after it completes. */
  batchStarting?: boolean;
  /** Estimated seconds until embedding completes. Only present during the embedding phase. */
  estimatedSecondsRemaining?: number;
}

export type ProgressCallback = (progress: IndexProgress) => void;

interface PendingChunk {
  id: string;
  texts: Array<{
    text: string;
    tokenCount: number;
  }>;
  storageText: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

interface PendingEmbeddingRequest {
  chunk: PendingChunk;
  partIndex: number;
  text: string;
  tokenCount: number;
}

interface FailedBatch {
  chunks: PendingChunk[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

interface RetryableFailedChunk {
  chunk: PendingChunk;
  attemptCount: number;
}

interface SerializedFailedBatch {
  chunks: unknown[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

type RankedCandidate = { id: string; score: number; metadata: ChunkMetadata };

interface RerankDocumentPayload {
  id: string;
  text: string;
}

type ExternalRerankBand = "implementation" | "documentation" | "test" | "other";

interface HybridRankOptions {
  fusionStrategy: "weighted" | "rrf";
  rrfK: number;
  rerankTopN: number;
  limit: number;
  hybridWeight: number;
}

interface SemanticRankOptions {
  rerankTopN: number;
  limit: number;
  prioritizeSourcePaths?: boolean;
}

interface IndexMetadata {
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingStrategyVersion: string;
  createdAt: string;
  updatedAt: string;
}

enum IncompatibilityCode {
  DIMENSION_MISMATCH = "DIMENSION_MISMATCH",
  MODEL_MISMATCH = "MODEL_MISMATCH",
  EMBEDDING_STRATEGY_MISMATCH = "EMBEDDING_STRATEGY_MISMATCH",
}

interface IndexCompatibility {
  compatible: boolean;
  code?: IncompatibilityCode;
  reason?: string;
  storedMetadata?: IndexMetadata;
}

const INDEX_METADATA_VERSION = "1";
const EMBEDDING_STRATEGY_VERSION = "2";
const RANKING_TOKEN_CACHE_LIMIT = 4096;
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createPendingChunkStorageText(texts: PendingChunk["texts"]): string {
  const primaryText = texts[0]?.text ?? "";
  if (texts.length <= 1) {
    return primaryText;
  }

  return `${primaryText}\n\n... [split into ${texts.length} parts for embedding]`;
}

function normalizePendingChunk(rawChunk: unknown, maxChunkTokens?: number): PendingChunk | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }

  const chunk = rawChunk as {
    id?: unknown;
    text?: unknown;
    texts?: Array<{ text?: unknown; tokenCount?: unknown }>;
    storageText?: unknown;
    content?: unknown;
    contentHash?: unknown;
    metadata?: unknown;
  };

  if (typeof chunk.id !== "string" || typeof chunk.contentHash !== "string" || !chunk.metadata || typeof chunk.metadata !== "object") {
    return null;
  }

  const texts = Array.isArray(chunk.texts)
    ? chunk.texts
      .map((entry) => {
        if (!entry || typeof entry.text !== "string") {
          return null;
        }

        return {
          text: entry.text,
          tokenCount: typeof entry.tokenCount === "number" && Number.isFinite(entry.tokenCount)
            ? entry.tokenCount
            : estimateTokens(entry.text),
        };
      })
      .filter((entry): entry is PendingChunk["texts"][number] => entry !== null)
    : [];

  if (texts.length === 0 && typeof chunk.text === "string") {
    if (typeof chunk.content === "string" && chunk.content.length > 0 && chunk.metadata && typeof chunk.metadata === "object") {
      const metadata = chunk.metadata as Partial<ChunkMetadata>;
      const rebuiltChunk = {
        content: chunk.content,
        startLine: typeof metadata.startLine === "number" ? metadata.startLine : 1,
        endLine: typeof metadata.endLine === "number" ? metadata.endLine : 1,
        chunkType: typeof metadata.chunkType === "string" ? metadata.chunkType : "other",
        name: typeof metadata.name === "string" ? metadata.name : undefined,
        language: typeof metadata.language === "string" ? metadata.language : "text",
      };
      const filePath = typeof metadata.filePath === "string" ? metadata.filePath : "unknown";
      texts.push(
        ...createEmbeddingTexts(rebuiltChunk, filePath, maxChunkTokens).map((text) => ({
          text,
          tokenCount: estimateTokens(text),
        }))
      );
    } else {
      texts.push({
        text: chunk.text,
        tokenCount: estimateTokens(chunk.text),
      });
    }
  }

  if (texts.length === 0) {
    return null;
  }

  return {
    id: chunk.id,
    texts,
    storageText: typeof chunk.storageText === "string" ? chunk.storageText : createPendingChunkStorageText(texts),
    content: typeof chunk.content === "string" ? chunk.content : "",
    contentHash: chunk.contentHash,
    metadata: chunk.metadata as ChunkMetadata,
  };
}

function getPendingChunkFilePath(rawChunk: unknown): string | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }

  const chunk = rawChunk as { metadata?: unknown };
  if (!chunk.metadata || typeof chunk.metadata !== "object") {
    return null;
  }

  const metadata = chunk.metadata as { filePath?: unknown };
  return typeof metadata.filePath === "string" ? metadata.filePath : null;
}

function normalizeFailedBatch(batch: SerializedFailedBatch, maxChunkTokens?: number): FailedBatch | null {
  const chunks = batch.chunks
    .map((chunk) => normalizePendingChunk(chunk, maxChunkTokens))
    .filter((chunk): chunk is PendingChunk => chunk !== null);

  if (chunks.length === 0) {
    return null;
  }

  return {
    chunks,
    error: batch.error,
    attemptCount: batch.attemptCount,
    lastAttempt: batch.lastAttempt,
  } satisfies FailedBatch;
}

function createPendingEmbeddingRequests(chunks: PendingChunk[]): PendingEmbeddingRequest[] {
  return chunks.flatMap((chunk) =>
    chunk.texts.map((textPart, partIndex) => ({
      chunk,
      partIndex,
      text: textPart.text,
      tokenCount: textPart.tokenCount,
    }))
  );
}

function createPendingEmbeddingRequestBatches(
  chunks: PendingChunk[],
  options: { maxBatchTokens?: number; maxBatchItems?: number } = {}
): PendingEmbeddingRequest[][] {
  return createDynamicBatches(createPendingEmbeddingRequests(chunks), options);
}

function getUniquePendingChunksFromRequests(requests: PendingEmbeddingRequest[]): PendingChunk[] {
  const uniqueChunks = new Map<string, PendingChunk>();
  for (const request of requests) {
    uniqueChunks.set(request.chunk.id, request.chunk);
  }
  return Array.from(uniqueChunks.values());
}

function coalesceFailedBatches(batches: FailedBatch[]): FailedBatch[] {
  const grouped = new Map<string, FailedBatch>();

  for (const batch of batches) {
    const key = `${batch.attemptCount}:${batch.lastAttempt}:${batch.error}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...batch,
        chunks: [...batch.chunks],
      });
      continue;
    }

    existing.chunks.push(...batch.chunks);
  }

  return Array.from(grouped.values());
}

function poolEmbeddingVectors(vectors: number[][], weights: number[]): number[] {
  const firstVector = vectors[0];
  if (!firstVector) {
    return [];
  }

  const pooled = new Array<number>(firstVector.length).fill(0);
  let totalWeight = 0;

  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index];
    const weight = Math.max(1, weights[index] ?? 1);
    totalWeight += weight;

    for (let dimension = 0; dimension < vector.length; dimension++) {
      pooled[dimension] += vector[dimension] * weight;
    }
  }

  if (totalWeight === 0) {
    return firstVector;
  }

  return pooled.map((value) => value / totalWeight);
}

function hasAllEmbeddingParts(
  parts: Array<{ vector: number[]; tokenCount: number } | undefined>,
  expectedPartCount: number
): boolean {
  if (parts.length !== expectedPartCount) {
    return false;
  }

  for (let index = 0; index < expectedPartCount; index++) {
    if (parts[index] === undefined) {
      return false;
    }
  }

  return true;
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootPath);
  return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}${path.sep}`);
}

const rankingQueryTokenCache = new Map<string, Set<string>>();
const rankingNameTokenCache = new Map<string, Set<string>>();
const rankingPathTokenCache = new Map<string, Set<string>>();
const rankingTextTokenCache = new Map<string, Set<string>>();
const queryIntentRawCache = new Map<string, "source" | "doc_test">();
const queryIdentifierHintsCache = new Map<string, string[]>();
const implementationPathCache = new Map<string, boolean>();
const testOrDocPathCache = new Map<string, boolean>();

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "using", "where",
  "what", "when", "why", "how", "are", "was", "were", "be", "been", "being",
  "find", "show", "get", "run", "use", "code", "function", "implementation",
  "retrieve", "results", "result", "search", "pipeline", "top", "in", "on", "of",
  "to", "by", "as", "or", "an", "a",
]);

const TEST_PATH_SEGMENTS = [
  "tests/",
  "__tests__/",
  "/test/",
  "fixtures/",
  "benchmark",
  "README",
  "ARCHITECTURE",
  "docs/",
];

const IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS = [
  "tests/",
  "__tests__/",
  "/test/",
  "fixtures/",
  "benchmark",
  "readme",
  "architecture",
  "docs/",
  "examples/",
  "example/",
  ".github/",
  "/scripts/",
  "/migrations/",
  "/generated/",
];

const SOURCE_INTENT_HINTS = new Set([
  "implement",
  "implementation",
  "function",
  "method",
  "class",
  "logic",
  "algorithm",
  "pipeline",
  "indexer",
  "where",
]);

const DOC_TEST_INTENT_HINTS = new Set([
  "test",
  "tests",
  "fixture",
  "fixtures",
  "benchmark",
  "readme",
  "docs",
  "documentation",
]);

const DOC_INTENT_HINTS = new Set([
  "readme",
  "docs",
  "documentation",
  "guide",
  "usage",
]);

const CLASSIFY_RAW_SOURCE_HINTS = [
  "implement",
  "implementation",
  "implements",
  "function",
  "method",
  "class",
  "logic",
  "algorithm",
  "pipeline",
  "indexer",
];

const CLASSIFY_RAW_DOC_TEST_REGEXES = Array.from(DOC_TEST_INTENT_HINTS).map(
  (hint) => new RegExp(`\\b${hint}\\b`)
);
const CLASSIFY_RAW_SOURCE_REGEXES = CLASSIFY_RAW_SOURCE_HINTS.map(
  (hint) => new RegExp(`\\b${hint}\\b`)
);
const WHERE_IS_PATTERN = /\bwhere\s+is\b/;

const IMPLEMENTATION_CHUNK_TYPES = new Set([
  "export_statement",
  "function",
  "function_declaration",
  "method",
  "method_definition",
  "class",
  "class_declaration",
  "interface",
  "type",
  "enum",
  "module",
]);

const NON_IMPLEMENTATION_EXTENSIONS = new Set([
  "md", "mdx", "txt", "rst", "adoc", "snap", "json", "yaml", "yml", "lock",
]);

const DOCUMENTATION_EXTENSIONS = new Set([
  "md", "mdx", "rst", "adoc", "txt",
]);

const DOC_TEST_INTENT_TOKENS = ["test", "tests", "fixture", "fixtures", "benchmark"];

const IDENTIFIER_HINT_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;
const HAS_UPPERCASE_PATTERN = /[A-Z]/;

function setBoundedMapCache<V>(
  cache: Map<string, V>,
  key: string,
  value: V
): void {
  if (cache.size >= RANKING_TOKEN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

function setBoundedCache(
  cache: Map<string, Set<string>>,
  key: string,
  value: Set<string>
): void {
  if (cache.size >= RANKING_TOKEN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

function tokenizeTextForRanking(text: string): Set<string> {
  if (!text) {
    return new Set<string>();
  }

  const lowered = text.toLowerCase();
  const cache = rankingQueryTokenCache.get(lowered) ?? rankingTextTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const tokens = new Set(
    lowered
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );

  setBoundedCache(rankingQueryTokenCache, lowered, tokens);
  setBoundedCache(rankingTextTokenCache, lowered, tokens);
  return tokens;
}

function splitPathTokens(filePath: string): Set<string> {
  const lowered = filePath.toLowerCase();
  const cache = rankingPathTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const normalized = lowered
    .replace(/[^a-z0-9/._-]/g, " ")
    .split(/[/._-]+/)
    .filter((token) => token.length > 1);
  const tokens = new Set(normalized);
  setBoundedCache(rankingPathTokenCache, lowered, tokens);
  return tokens;
}

function splitNameTokens(name: string): Set<string> {
  if (!name) {
    return new Set<string>();
  }

  const lowered = name.toLowerCase();
  const cache = rankingNameTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const tokens = new Set(
    lowered
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
  setBoundedCache(rankingNameTokenCache, lowered, tokens);
  return tokens;
}

function chunkTypeBoost(chunkType: string): number {
  switch (chunkType) {
    case "function":
    case "function_declaration":
    case "method":
    case "method_definition":
    case "class":
    case "class_declaration":
      return 0.2;
    case "interface":
    case "type":
    case "enum":
    case "struct":
    case "impl":
    case "trait":
    case "module":
      return 0.1;
    default:
      return 0;
  }
}

function isTestOrDocPath(filePath: string): boolean {
  const cached = testOrDocPathCache.get(filePath);
  if (cached !== undefined) return cached;
  let result = false;
  for (let i = 0; i < TEST_PATH_SEGMENTS.length; i += 1) {
    if (filePath.includes(TEST_PATH_SEGMENTS[i])) {
      result = true;
      break;
    }
  }
  setBoundedMapCache(testOrDocPathCache, filePath, result);
  return result;
}

function isLikelyImplementationPath(filePath: string): boolean {
  const cached = implementationPathCache.get(filePath);
  if (cached !== undefined) return cached;
  const lowered = filePath.toLowerCase();
  let result = true;
  for (let i = 0; i < IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS.length; i += 1) {
    if (lowered.includes(IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS[i])) {
      result = false;
      break;
    }
  }
  if (result) {
    const dotIdx = lowered.lastIndexOf(".");
    const ext = dotIdx >= 0 ? lowered.slice(dotIdx + 1) : "";
    if (NON_IMPLEMENTATION_EXTENSIONS.has(ext)) {
      result = false;
    }
  }
  setBoundedMapCache(implementationPathCache, filePath, result);
  return result;
}

function isDocumentationPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  const dotIdx = lowered.lastIndexOf(".");
  const ext = dotIdx >= 0 ? lowered.slice(dotIdx + 1) : "";
  return lowered.includes("readme") || DOCUMENTATION_EXTENSIONS.has(ext);
}

function classifyExternalRerankBand(
  candidate: RankedCandidate,
  preferSourcePaths: boolean,
  docIntent: boolean
): ExternalRerankBand {
  const isDocOrTest = isTestOrDocPath(candidate.metadata.filePath);
  const isDocumentation = isDocumentationPath(candidate.metadata.filePath);
  const isImplementation = isLikelyImplementationPath(candidate.metadata.filePath) &&
    isImplementationChunkType(candidate.metadata.chunkType);

  if (preferSourcePaths) {
    if (isImplementation) return "implementation";
    if (isDocumentation) return "documentation";
    if (isDocOrTest) return "test";
    return "other";
  }

  if (docIntent) {
    if (isDocumentation) return "documentation";
    if (isImplementation) return "implementation";
    if (isDocOrTest) return "test";
    return "other";
  }

  if (isImplementation) return "implementation";
  if (isDocumentation) return "documentation";
  if (isDocOrTest) return "test";
  return "other";
}

function classifyQueryIntent(tokens: string[]): "source" | "doc_test" {
  let sourceIntentHits = 0;
  let docTestIntentHits = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (SOURCE_INTENT_HINTS.has(t)) sourceIntentHits += 1;
    if (DOC_TEST_INTENT_HINTS.has(t)) docTestIntentHits += 1;
  }
  return sourceIntentHits >= docTestIntentHits ? "source" : "doc_test";
}

function classifyQueryIntentRaw(query: string): "source" | "doc_test" {
  const cached = queryIntentRawCache.get(query);
  if (cached !== undefined) return cached;

  const lowerQuery = query.toLowerCase();
  let docTestRawHits = 0;
  for (let i = 0; i < CLASSIFY_RAW_DOC_TEST_REGEXES.length; i += 1) {
    if (CLASSIFY_RAW_DOC_TEST_REGEXES[i].test(lowerQuery)) docTestRawHits += 1;
  }
  let sourceRawHits = 0;
  for (let i = 0; i < CLASSIFY_RAW_SOURCE_REGEXES.length; i += 1) {
    if (CLASSIFY_RAW_SOURCE_REGEXES[i].test(lowerQuery)) sourceRawHits += 1;
  }

  let result: "source" | "doc_test";
  if (docTestRawHits > sourceRawHits) {
    result = "doc_test";
  } else if (sourceRawHits > docTestRawHits) {
    result = "source";
  } else if (
    WHERE_IS_PATTERN.test(lowerQuery) &&
    extractIdentifierHints(query).length > 0 &&
    docTestRawHits === 0
  ) {
    result = "source";
  } else {
    const queryTokens = Array.from(tokenizeTextForRanking(query));
    result = classifyQueryIntent(queryTokens);
  }
  setBoundedMapCache(queryIntentRawCache, query, result);
  return result;
}

function classifyDocIntent(tokens: string[]): "docs" | "test" | "mixed" | "none" {
  let docHits = 0;
  let testHits = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (DOC_INTENT_HINTS.has(t)) docHits += 1;
    if (DOC_TEST_INTENT_TOKENS.indexOf(t) !== -1) testHits += 1;
  }

  if (docHits > 0 && testHits === 0) return "docs";
  if (testHits > 0 && docHits === 0) return "test";
  if (testHits > 0 || docHits > 0) return "mixed";
  return "none";
}

function isImplementationChunkType(chunkType: string): boolean {
  return IMPLEMENTATION_CHUNK_TYPES.has(chunkType);
}

function extractIdentifierHints(query: string): string[] {
  const cached = queryIdentifierHintsCache.get(query);
  if (cached !== undefined) return cached;

  IDENTIFIER_HINT_PATTERN.lastIndex = 0;
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_HINT_PATTERN.exec(query)) !== null) {
    const id = match[0];
    if (id.length < 3) continue;
    const lower = id.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (
      HAS_UPPERCASE_PATTERN.test(id) ||
      id.indexOf("_") !== -1 ||
      id.endsWith("Results") ||
      id.endsWith("Result")
    ) {
      result.push(lower);
    }
  }
  setBoundedMapCache(queryIdentifierHintsCache, query, result);
  return result;
}

function extractCodeTermHints(query: string): string[] {
  const terms = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
    .filter((term) => !STOPWORDS.has(term));
}

function normalizeIdentifierVariants(identifier: string): string[] {
  const lower = identifier.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const snake = compact.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const kebab = snake.replace(/_/g, "-");
  const variants = [lower, compact, snake, kebab].filter((value) => value.length > 0);
  return Array.from(new Set(variants));
}

function scoreIdentifierMatch(name: string | undefined, filePath: string, hints: string[]): number {
  const nameLower = (name ?? "").toLowerCase();
  const pathLower = filePath.toLowerCase();

  let best = 0;
  for (const hint of hints) {
    const variants = normalizeIdentifierVariants(hint);
    for (const variant of variants) {
      if (nameLower === variant) {
        best = Math.max(best, 1);
      } else if (nameLower.includes(variant)) {
        best = Math.max(best, 0.8);
      } else if (pathLower.includes(variant)) {
        best = Math.max(best, 0.6);
      }
    }
  }

  return best;
}

function extractPrimaryIdentifierQueryHint(query: string): string | null {
  const identifiers = extractIdentifierHints(query);
  if (identifiers.length > 0) {
    return identifiers[0] ?? null;
  }

  const codeTerms = extractCodeTermHints(query);
  const best = codeTerms.find((term) => term.length >= 6);
  return best ?? null;
}

const FILE_PATH_HINT_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "rs", "go", "java", "kt", "kts", "swift", "rb", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "scala", "lua",
  "sh", "bash", "zsh", "json", "yaml", "yml", "toml",
];

const FILE_PATH_HINT_SUFFIX_REGEX = new RegExp(
  "\\s+\\bin\\s+[\"'`]?((?:\\.\\/)?(?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.(?:" +
  FILE_PATH_HINT_EXTENSIONS.join("|") +
  "))[\"'`]?[\\])}>.,;!?]*\\s*$",
  "i"
);

function normalizeFilePathForHintMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase().replace(/^\.\//, "");
}

function pathMatchesHint(filePath: string, hint: string): boolean {
  const normalizedPath = normalizeFilePathForHintMatch(filePath);
  const normalizedHint = normalizeFilePathForHintMatch(hint);

  return normalizedPath.endsWith(normalizedHint) ||
    normalizedPath.includes(`/${normalizedHint}`) ||
    normalizedPath.includes(normalizedHint);
}

export function extractFilePathHint(query: string): string | null {
  const match = query.match(FILE_PATH_HINT_SUFFIX_REGEX);
  const rawPath = match?.[1];
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^\.\//, "");
}

export function stripFilePathHint(query: string): string {
  const stripped = query.replace(FILE_PATH_HINT_SUFFIX_REGEX, "").trim();
  return stripped.length > 0 ? stripped : query;
}

function buildDeterministicIdentifierPass(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primary = extractPrimaryIdentifierQueryHint(query);
  if (!primary) {
    return [];
  }
  const filePathHint = extractFilePathHint(query);
  const primaryVariants = normalizeIdentifierVariants(primary);

  const hints = [primary, ...extractIdentifierHints(query), ...extractCodeTermHints(query)]
    .map((value) => value.toLowerCase())
    .filter((value, idx, arr) => value.length >= 3 && arr.indexOf(value) === idx)
    .slice(0, 8);

  const deterministic = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();
      let maxMatch = 0;
      const nameMatchesPrimary = primaryVariants.some((variant) =>
        nameLower === variant || nameLower.replace(/[^a-z0-9]/g, "") === variant.replace(/[^a-z0-9]/g, "")
      );
      const pathMatchesFileHint = filePathHint ? pathMatchesHint(candidate.metadata.filePath, filePathHint) : false;

      for (const hint of hints) {
        const variants = normalizeIdentifierVariants(hint);
        for (const variant of variants) {
          if (nameLower === variant) {
            maxMatch = Math.max(maxMatch, 1);
          } else if (nameLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.85);
          } else if (pathLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.7);
          }
        }
      }

      if (pathMatchesFileHint && nameMatchesPrimary) {
        maxMatch = Math.max(maxMatch, 1);
      }

      return {
        candidate,
        maxMatch,
        pathMatchesFileHint,
        nameMatchesPrimary,
      };
    })
    .filter((entry) => entry.maxMatch >= 0.7)
    .sort((a, b) => {
      const aAnchored = a.pathMatchesFileHint && a.nameMatchesPrimary ? 1 : 0;
      const bAnchored = b.pathMatchesFileHint && b.nameMatchesPrimary ? 1 : 0;
      if (aAnchored !== bAnchored) return bAnchored - aAnchored;
      if (b.maxMatch !== a.maxMatch) return b.maxMatch - a.maxMatch;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 12));

  return deterministic.map((entry) => ({
    id: entry.candidate.id,
    score: entry.pathMatchesFileHint && entry.nameMatchesPrimary
      ? 0.995
      : Math.min(1, 0.9 + entry.maxMatch * 0.09),
    metadata: entry.candidate.metadata,
  }));
}

export function fuseResultsWeighted(
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  keywordWeight: number,
  limit: number
): RankedCandidate[] {
  const semanticWeight = 1 - keywordWeight;
  const fusedScores = new Map<string, { score: number; metadata: ChunkMetadata }>();

  for (const r of semanticResults) {
    fusedScores.set(r.id, {
      score: r.score * semanticWeight,
      metadata: r.metadata,
    });
  }

  for (const r of keywordResults) {
    const existing = fusedScores.get(r.id);
    if (existing) {
      existing.score += r.score * keywordWeight;
    } else {
      fusedScores.set(r.id, {
        score: r.score * keywordWeight,
        metadata: r.metadata,
      });
    }
  }

  const results = Array.from(fusedScores.entries()).map(([id, data]) => ({
    id,
    score: data.score,
    metadata: data.metadata,
  }));

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, limit);
}

export function fuseResultsRrf(
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  rrfK: number,
  limit: number
): RankedCandidate[] {
  const maxPossibleRaw = 2 / (rrfK + 1);
  const rankByIdSemantic = new Map<string, number>();
  const rankByIdKeyword = new Map<string, number>();
  const metadataById = new Map<string, ChunkMetadata>();

  semanticResults.forEach((result, index) => {
    rankByIdSemantic.set(result.id, index + 1);
    metadataById.set(result.id, result.metadata);
  });

  keywordResults.forEach((result, index) => {
    rankByIdKeyword.set(result.id, index + 1);
    if (!metadataById.has(result.id)) {
      metadataById.set(result.id, result.metadata);
    }
  });

  const allIds = new Set<string>([...rankByIdSemantic.keys(), ...rankByIdKeyword.keys()]);
  const fused: RankedCandidate[] = [];

  for (const id of allIds) {
    const semanticRank = rankByIdSemantic.get(id);
    const keywordRank = rankByIdKeyword.get(id);

    const semanticScore = semanticRank ? 1 / (rrfK + semanticRank) : 0;
    const keywordScore = keywordRank ? 1 / (rrfK + keywordRank) : 0;

    const metadata = metadataById.get(id);
    if (!metadata) continue;

    fused.push({
      id,
      score: maxPossibleRaw > 0 ? (semanticScore + keywordScore) / maxPossibleRaw : 0,
      metadata,
    });
  }

  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return fused.slice(0, limit);
}

export function rerankResults(
  query: string,
  candidates: RankedCandidate[],
  rerankTopN: number,
  options?: { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  if (rerankTopN <= 0 || candidates.length <= 1) {
    return candidates;
  }

  const topN = Math.min(rerankTopN, candidates.length);
  const queryTokens = tokenizeTextForRanking(query);
  if (queryTokens.size === 0) {
    return candidates;
  }

  const queryTokenList = Array.from(queryTokens);
  const intent = classifyQueryIntentRaw(query);
  const docIntent = classifyDocIntent(queryTokenList);
  const preferSourcePaths = options?.prioritizeSourcePaths ?? intent === "source";
  const identifierHints = extractIdentifierHints(query);

  const head = candidates.slice(0, topN).map((candidate, idx) => {
    const pathTokens = splitPathTokens(candidate.metadata.filePath);
    const nameTokens = splitNameTokens(candidate.metadata.name ?? "");
    const chunkTypeTokens = tokenizeTextForRanking(candidate.metadata.chunkType);
    let exactOrPrefixNameHits = 0;
    let pathOverlap = 0;
    let chunkTypeHits = 0;

    for (const token of queryTokenList) {
      if (nameTokens.has(token)) {
        exactOrPrefixNameHits += 1;
      } else {
        for (const nameToken of nameTokens) {
          if (nameToken.startsWith(token) || token.startsWith(nameToken)) {
            exactOrPrefixNameHits += 1;
            break;
          }
        }
      }

      if (pathTokens.has(token)) {
        pathOverlap += 1;
      }

      if (chunkTypeTokens.has(token)) {
        chunkTypeHits += 1;
      }
    }

    const likelyTestOrDoc = isTestOrDocPath(candidate.metadata.filePath);
    const lowerPath = candidate.metadata.filePath.toLowerCase();
    const lowerName = (candidate.metadata.name ?? "").toLowerCase();
    const hasIdentifierMatch = identifierHints.some((id) => lowerPath.includes(id) || lowerName.includes(id));

    const implementationPathBoost = preferSourcePaths && isLikelyImplementationPath(candidate.metadata.filePath) ? 0.08 : 0;
    const isReadmePath = candidate.metadata.filePath.toLowerCase().includes("readme");
    const testDocPenalty = preferSourcePaths && likelyTestOrDoc ? 0.12 : 0;
    const readmeDocBoost = !preferSourcePaths && isReadmePath ? 0.08 : 0;
    const identifierBoost = hasIdentifierMatch ? 0.12 : 0;
    const tokenCoverage = queryTokenList.length > 0
      ? (exactOrPrefixNameHits + pathOverlap + chunkTypeHits) / queryTokenList.length
      : 0;
    const coverageBoost = Math.min(0.12, tokenCoverage * 0.06);

    const deterministicBoost =
      exactOrPrefixNameHits * 0.08 +
      pathOverlap * 0.03 +
      chunkTypeHits * 0.02 +
      coverageBoost +
      identifierBoost +
      implementationPathBoost -
      testDocPenalty +
      readmeDocBoost +
      chunkTypeBoost(candidate.metadata.chunkType);

    return {
      candidate,
      boostedScore: candidate.score + deterministicBoost,
      originalIndex: idx,
      hasIdentifierMatch,
      implementationChunk: isImplementationChunkType(candidate.metadata.chunkType),
      isLikelyImplementationPath: isLikelyImplementationPath(candidate.metadata.filePath),
      isTestOrDocPath: likelyTestOrDoc,
      isReadmePath,
    };
  });

  head.sort((a, b) => {
    if (b.boostedScore !== a.boostedScore) return b.boostedScore - a.boostedScore;
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
    if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  if (preferSourcePaths) {
    head.sort((a, b) => {
      const aId = a.hasIdentifierMatch ? 1 : 0;
      const bId = b.hasIdentifierMatch ? 1 : 0;
      if (aId !== bId) return bId - aId;

      const aImpl = a.implementationChunk ? 1 : 0;
      const bImpl = b.implementationChunk ? 1 : 0;
      if (aImpl !== bImpl) return bImpl - aImpl;

      const aImplementationPath = a.isLikelyImplementationPath ? 1 : 0;
      const bImplementationPath = b.isLikelyImplementationPath ? 1 : 0;
      if (aImplementationPath !== bImplementationPath) return bImplementationPath - aImplementationPath;

      const aTestDoc = a.isTestOrDocPath ? 1 : 0;
      const bTestDoc = b.isTestOrDocPath ? 1 : 0;
      if (aTestDoc !== bTestDoc) return aTestDoc - bTestDoc;

      return 0;
    });
  } else if (docIntent === "docs") {
    head.sort((a, b) => {
      const aReadme = a.isReadmePath ? 1 : 0;
      const bReadme = b.isReadmePath ? 1 : 0;
      if (aReadme !== bReadme) return bReadme - aReadme;
      return 0;
    });
  }

  const shouldDiversify = !(preferSourcePaths && identifierHints.length > 0);
  const diversifiedHead = diversifyEntriesByFileAndSymbol(head, (entry) => entry.candidate, shouldDiversify);

  const tail = candidates.slice(topN);
  return [...diversifiedHead.map((entry) => entry.candidate), ...tail];
}

function diversifyEntriesByFileAndSymbol<T>(
  entries: T[],
  getCandidate: (entry: T) => RankedCandidate,
  enabled: boolean
): T[] {
  if (!enabled || entries.length <= 2) {
    return entries;
  }

  const groups = new Map<string, T[]>();
  const groupOrder: string[] = [];

  for (const entry of entries) {
    const candidate = getCandidate(entry);
    const filePath = candidate.metadata.filePath;
    if (!groups.has(filePath)) {
      groups.set(filePath, []);
      groupOrder.push(filePath);
    }
    groups.get(filePath)?.push(entry);
  }

  const diversifiedGroups = groupOrder.map((filePath) => {
    const group = groups.get(filePath) ?? [];
    return diversifyGroupBySymbol(group, getCandidate);
  });

  const result: T[] = [];
  let added = true;
  let round = 0;
  while (added) {
    added = false;
    for (const group of diversifiedGroups) {
      const entry = group[round];
      if (entry !== undefined) {
        result.push(entry);
        added = true;
      }
    }
    round += 1;
  }

  return result;
}

function diversifyCandidatesByFile(candidates: RankedCandidate[], enabled: boolean): RankedCandidate[] {
  return diversifyEntriesByFileAndSymbol(candidates, (candidate) => candidate, enabled);
}

function diversifyGroupBySymbol<T>(
  entries: T[],
  getCandidate: (entry: T) => RankedCandidate
): T[] {
  if (entries.length <= 2) {
    return entries;
  }

  const seenKeys = new Set<string>();
  const primary: T[] = [];
  const remainder: T[] = [];

  for (const entry of entries) {
    const key = buildDiversityKey(getCandidate(entry).metadata);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      primary.push(entry);
    } else {
      remainder.push(entry);
    }
  }

  return [...primary, ...remainder];
}

function buildDiversityKey(metadata: ChunkMetadata): string {
  const normalizedPath = metadata.filePath.toLowerCase();
  const normalizedName = (metadata.name ?? "").trim().toLowerCase();
  if (normalizedName.length > 0) {
    return `${normalizedPath}#${normalizedName}`;
  }
  return normalizedPath;
}

export function rankHybridResults(
  query: string,
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  options: HybridRankOptions & { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const fused = options.fusionStrategy === "rrf"
    ? fuseResultsRrf(semanticResults, keywordResults, options.rrfK, overfetchLimit)
    : fuseResultsWeighted(semanticResults, keywordResults, options.hybridWeight, overfetchLimit);

  const rerankPoolLimit = Math.max(overfetchLimit, options.rerankTopN * 3, options.limit * 6);
  const rerankPool = fused.slice(0, rerankPoolLimit);
  return rerankResults(query, rerankPool, options.rerankTopN, {
    prioritizeSourcePaths: options.prioritizeSourcePaths ?? classifyQueryIntentRaw(query) === "source",
  });
}

export function rankSemanticOnlyResults(
  query: string,
  semanticResults: RankedCandidate[],
  options: SemanticRankOptions
): RankedCandidate[] {
  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const bounded = semanticResults.slice(0, overfetchLimit);
  return rerankResults(query, bounded, options.rerankTopN, {
    prioritizeSourcePaths: options.prioritizeSourcePaths ?? false,
  });
}

async function promoteIdentifierMatches(
  query: string,
  combined: RankedCandidate[],
  semanticCandidates: RankedCandidate[],
  keywordCandidates: RankedCandidate[],
  database?: IDatabaseBackend,
  branchChunkIds?: Set<string> | null,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): Promise<RankedCandidate[]> {
  if (combined.length === 0) {
    return combined;
  }

  if (!prioritizeSourcePaths) {
    return combined;
  }

  const identifierHints = extractIdentifierHints(query);
  if (identifierHints.length === 0) {
    return combined;
  }

  const combinedById = new Map(combined.map((candidate) => [candidate.id, candidate]));
  const candidateUnion = new Map<string, RankedCandidate>();
  for (const candidate of semanticCandidates) {
    candidateUnion.set(candidate.id, candidate);
  }
  for (const candidate of keywordCandidates) {
    if (!candidateUnion.has(candidate.id)) {
      candidateUnion.set(candidate.id, candidate);
    }
  }

  if (database) {
    for (const identifier of identifierHints) {
      const symbols = await database.getSymbolsByName(identifier);
      for (const symbol of symbols) {
        const chunks = await database.getChunksByFile(symbol.filePath);
        for (const chunk of chunks) {
          if (branchChunkIds && !branchChunkIds.has(chunk.chunkId)) {
            continue;
          }

          const chunkType = ((chunk.nodeType ?? "other") as ChunkMetadata["chunkType"]);
          if (!isImplementationChunkType(chunkType)) {
            continue;
          }

          if (!isLikelyImplementationPath(chunk.filePath)) {
            continue;
          }

          if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
            continue;
          }

          const existing = combinedById.get(chunk.chunkId) ?? candidateUnion.get(chunk.chunkId);
          const metadata: ChunkMetadata = existing?.metadata ?? {
            filePath: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            chunkType,
            name: chunk.name ?? undefined,
            language: chunk.language,
            hash: chunk.contentHash,
          };

          const baselineScore = existing?.score ?? 0.5;
          candidateUnion.set(chunk.chunkId, {
            id: chunk.chunkId,
            score: Math.min(1, baselineScore + 0.5),
            metadata,
          });
        }
      }
    }
  }

  const promoted: RankedCandidate[] = [];
  for (const candidate of candidateUnion.values()) {
    const filePathLower = candidate.metadata.filePath.toLowerCase();
    const nameLower = (candidate.metadata.name ?? "").toLowerCase();
    const exactIdentifierMatch = identifierHints.some((hint) => nameLower === hint);
    const hasIdentifierMatch = exactIdentifierMatch || identifierHints.some((hint) =>
      nameLower.includes(hint) ||
      filePathLower.includes(hint)
    );

    if (!hasIdentifierMatch) {
      continue;
    }

    if (!isImplementationChunkType(candidate.metadata.chunkType)) {
      continue;
    }

    if (!isLikelyImplementationPath(candidate.metadata.filePath)) {
      continue;
    }

    const existing = combinedById.get(candidate.id) ?? candidate;
    const rescueBoost = exactIdentifierMatch ? 0.45 : 0.25;
    const boostedScore = Math.min(1, Math.max(existing.score, candidate.score) + rescueBoost);
    promoted.push({
      id: existing.id,
      score: boostedScore,
      metadata: existing.metadata,
    });
  }

  if (promoted.length === 0) {
    return combined;
  }

  promoted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const promotedIds = new Set(promoted.map((candidate) => candidate.id));
  const remainder = combined.filter((candidate) => !promotedIds.has(candidate.id));
  return [...promoted, ...remainder];
}

async function buildSymbolDefinitionLane(
  query: string,
  database: IDatabaseBackend,
  branchChunkIds: Set<string> | null,
  limit: number,
  fallbackCandidates: RankedCandidate[],
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): Promise<RankedCandidate[]> {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const identifierHints = extractIdentifierHints(query);
  const codeTermHints = extractCodeTermHints(query);
  if (identifierHints.length === 0 && codeTermHints.length === 0) {
    return [];
  }

  const symbolCandidates = new Map<string, RankedCandidate>();
  const filePathHint = extractFilePathHint(query);
  const primaryHint = extractPrimaryIdentifierQueryHint(query);

  const upsertChunkCandidate = (
    chunk: ChunkData,
    identifier: string,
    normalizedIdentifier: string,
    baseScore?: number
  ) => {
    if (branchChunkIds && !branchChunkIds.has(chunk.chunkId)) {
      return;
    }

    const chunkType = (chunk.nodeType ?? "other") as ChunkMetadata["chunkType"];
    if (!isImplementationChunkType(chunkType)) {
      return;
    }

    if (!isLikelyImplementationPath(chunk.filePath)) {
      return;
    }

    const nameLower = (chunk.name ?? "").toLowerCase();
    const exactName =
      nameLower === identifier ||
      nameLower.replace(/_/g, "") === normalizedIdentifier;
    const base = baseScore ?? (exactName ? 0.99 : 0.88);

    const existing = symbolCandidates.get(chunk.chunkId);
    if (!existing || base > existing.score) {
      symbolCandidates.set(chunk.chunkId, {
        id: chunk.chunkId,
        score: base,
        metadata: {
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType,
          name: chunk.name ?? undefined,
          language: chunk.language,
          hash: chunk.contentHash,
        },
      });
    }
  };

  const normalizedHints = identifierHints
    .flatMap((hint) => [
      hint,
      hint.replace(/_/g, ""),
      hint.replace(/_/g, "-")
    ])
    .filter((hint, idx, arr) => hint.length >= 3 && arr.indexOf(hint) === idx)
    .slice(0, 6);

  for (const identifier of normalizedHints) {
    const symbols = [
      ...(await database.getSymbolsByName(identifier)),
      ...(await database.getSymbolsByNameCi(identifier)),
    ];

    const chunksByName = [
      ...(await database.getChunksByName(identifier)),
      ...(await database.getChunksByNameCi(identifier)),
    ];

    const normalizedIdentifier = identifier.replace(/_/g, "");

    const dedupSymbols = new Map<string, typeof symbols[number]>();
    for (const symbol of symbols) {
      dedupSymbols.set(symbol.id, symbol);
    }

    for (const symbol of dedupSymbols.values()) {
      const chunks = await database.getChunksByFile(symbol.filePath);
      for (const chunk of chunks) {
        if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
          continue;
        }

        upsertChunkCandidate(chunk, identifier, normalizedIdentifier);
      }
    }

    const dedupChunksByName = new Map<string, typeof chunksByName[number]>();
    for (const chunk of chunksByName) {
      dedupChunksByName.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupChunksByName.values()) {
      upsertChunkCandidate(chunk, identifier, normalizedIdentifier);
    }
  }

  if (filePathHint && primaryHint) {
    const primaryChunks = [
      ...(await database.getChunksByName(primaryHint)),
      ...(await database.getChunksByNameCi(primaryHint)),
    ];
    const dedupPrimaryChunks = new Map<string, typeof primaryChunks[number]>();
    for (const chunk of primaryChunks) {
      dedupPrimaryChunks.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupPrimaryChunks.values()) {
      if (!pathMatchesHint(chunk.filePath, filePathHint)) {
        continue;
      }
      const normalizedPrimary = primaryHint.replace(/_/g, "");
      upsertChunkCandidate(chunk, primaryHint, normalizedPrimary, 1.0);
    }
  }

  const ranked = Array.from(symbolCandidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (ranked.length === 0) {
    const implementationFallback = fallbackCandidates.filter((candidate) =>
      isImplementationChunkType(candidate.metadata.chunkType) &&
      isLikelyImplementationPath(candidate.metadata.filePath)
    );

    for (const candidate of implementationFallback) {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();

      const exactHintMatch = normalizedHints.some((hint) => nameLower === hint || nameLower.replace(/_/g, "") === hint.replace(/_/g, ""));
      const tokenizedName = tokenizeTextForRanking(nameLower);
      const tokenHits = codeTermHints.filter((term) => tokenizedName.has(term) || pathLower.includes(term)).length;

      if (!exactHintMatch && tokenHits === 0) {
        continue;
      }

      const laneScore = exactHintMatch
        ? Math.min(1, Math.max(candidate.score, 0.97))
        : Math.min(0.95, Math.max(candidate.score, 0.82 + tokenHits * 0.03));
      symbolCandidates.set(candidate.id, {
        id: candidate.id,
        score: laneScore,
        metadata: candidate.metadata,
      });
    }

    if (symbolCandidates.size === 0) {
      const queryTokenSet = tokenizeTextForRanking(query);
      const rankedFallback = implementationFallback
        .map((candidate) => {
          const nameTokens = tokenizeTextForRanking(candidate.metadata.name ?? "");
          const pathTokens = splitPathTokens(candidate.metadata.filePath);
          let overlap = 0;
          for (const token of queryTokenSet) {
            if (nameTokens.has(token) || pathTokens.has(token)) {
              overlap += 1;
            }
          }
          const overlapScore = queryTokenSet.size > 0 ? overlap / queryTokenSet.size : 0;
          return {
            candidate,
            overlapScore,
          };
        })
        .filter((entry) => entry.overlapScore > 0)
        .sort((a, b) => b.overlapScore - a.overlapScore || b.candidate.score - a.candidate.score)
        .slice(0, Math.max(limit, 3));

      for (const entry of rankedFallback) {
        symbolCandidates.set(entry.candidate.id, {
          id: entry.candidate.id,
          score: Math.min(0.94, Math.max(entry.candidate.score, 0.8 + entry.overlapScore * 0.1)),
          metadata: entry.candidate.metadata,
        });
      }
    }
  }

  const withFallback = Array.from(symbolCandidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return withFallback.slice(0, Math.max(limit * 2, limit));
}

function buildIdentifierDefinitionLane(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primaryHint = extractPrimaryIdentifierQueryHint(query);
  if (!primaryHint) {
    return [];
  }

  const hints = [primaryHint, ...extractIdentifierHints(query), ...extractCodeTermHints(query)].slice(0, 8);
  const scored = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const matchScore = scoreIdentifierMatch(candidate.metadata.name, candidate.metadata.filePath, hints);
      return {
        candidate,
        matchScore,
      };
    })
    .filter((entry) => entry.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 10));

  return scored.map((entry) => ({
    id: entry.candidate.id,
    score: Math.min(1, 0.9 + entry.matchScore * 0.09),
    metadata: entry.candidate.metadata,
  }));
}

export function mergeTieredResults(
  symbolLane: RankedCandidate[],
  hybridLane: RankedCandidate[],
  limit: number
): RankedCandidate[] {
  if (symbolLane.length === 0) {
    return hybridLane.slice(0, limit);
  }

  const out: RankedCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of symbolLane) {
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
    if (out.length >= limit) return out;
  }

  for (const candidate of hybridLane) {
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
    if (out.length >= limit) return out;
  }

  return out;
}

function unionCandidates(
  semanticCandidates: RankedCandidate[],
  keywordCandidates: RankedCandidate[]
): RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const candidate of semanticCandidates) {
    byId.set(candidate.id, candidate);
  }
  for (const candidate of keywordCandidates) {
    const existing = byId.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      byId.set(candidate.id, candidate);
    }
  }
  return Array.from(byId.values());
}

export class Indexer {
  private config: ParsedCodebaseIndexConfig;
  private projectRoot: string;
  private indexPath: string;
  private store: IVectorStoreBackend | null = null;
  private invertedIndex: InvertedIndex | null = null;
  private database: IDatabaseBackend | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private configuredProviderInfo: ConfiguredProviderInfo | null = null;
  private reranker: RerankerInterface | null = null;
  private failedBatchesPath: string = "";
  private currentBranch: string = "default";
  private baseBranch: string = "main";
  private logger: Logger;
  private client?: { app?: { log: (entry: unknown) => Promise<unknown> } };
  private currentProgress?: IndexProgress;
  private lastProgressLogAt = 0;
  private lastProgressSnapshot = "";
  private embeddingPhaseStartTime = 0;
  private embeddingChunksAtStart = 0;
  private lastProgressPersistAt = 0;
  private queryEmbeddingCache: Map<string, { embedding: number[]; timestamp: number }> = new Map();
  private readonly maxQueryCacheSize = 100;
  private readonly queryCacheTtlMs = 5 * 60 * 1000;
  private readonly querySimilarityThreshold = 0.85;
  private indexCompatibility: IndexCompatibility | null = null;
  /** Cached flag: whether the global branch catalog migration has been completed. */
  private branchMigrationDone = false;

  constructor(projectRoot: string, config: ParsedCodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
    this.logger = initializeLogger(config.debug);
  }

  private updateProgress(progress: IndexProgress, onProgress?: ProgressCallback): void {
    // Compute ETA for embedding phase
    let estimatedSecondsRemaining: number | undefined;
    if (progress.phase === "embedding") {
      if (this.embeddingPhaseStartTime === 0 && progress.chunksProcessed > 0) {
        this.embeddingPhaseStartTime = Date.now();
        this.embeddingChunksAtStart = progress.chunksProcessed;
      }
      if (this.embeddingPhaseStartTime > 0) {
        const elapsedMs = Date.now() - this.embeddingPhaseStartTime;
        const done = progress.chunksProcessed - this.embeddingChunksAtStart;
        const remaining = progress.totalChunks - progress.chunksProcessed;
        if (done > 0 && elapsedMs > 0 && remaining >= 0) {
          const ratePerSec = done / (elapsedMs / 1000);
          estimatedSecondsRemaining = Math.ceil(remaining / ratePerSec);
        }
      }
    } else {
      this.embeddingPhaseStartTime = 0;
      this.embeddingChunksAtStart = 0;
    }

    const enriched: IndexProgress = estimatedSecondsRemaining !== undefined
      ? { ...progress, estimatedSecondsRemaining }
      : progress;

    this.currentProgress = enriched;
    onProgress?.(enriched);
    this.emitProgressLog(enriched);

    // Persist snapshot to DB for cross-invocation status (debounced, fire-and-forget)
    const now = Date.now();
    if (this.database && progress.phase !== "complete" && now - this.lastProgressPersistAt >= 5000) {
      this.lastProgressPersistAt = now;
      void this.database.setMetadata(PROGRESS_SNAPSHOT_KEY, JSON.stringify({ ...enriched, persistedAt: now }))
        .catch(() => { /* best-effort */ });
    }
  }

  private emitProgressLog(progress: IndexProgress): void {
    if (!this.client?.app?.log) {
      return;
    }

    const now = Date.now();
    const snapshot = `${progress.phase}:${progress.filesProcessed}/${progress.totalFiles}:${progress.chunksProcessed}/${progress.totalChunks}:${progress.currentFiles?.join(",") ?? ""}`;
    const shouldLog =
      progress.phase === "scanning"
      || progress.phase === "storing"
      || progress.phase === "complete"
      || this.lastProgressSnapshot === ""
      || snapshot !== this.lastProgressSnapshot && now - this.lastProgressLogAt >= 1500;

    if (!shouldLog) {
      return;
    }

    this.lastProgressLogAt = now;
    this.lastProgressSnapshot = snapshot;

    const message = (() => {
      switch (progress.phase) {
        case "scanning":
          return "Indexing: scanning files";
        case "parsing":
          return `Indexing: parsed ${progress.filesProcessed}/${progress.totalFiles} files`;
        case "embedding":
          return `Indexing: embedded ${progress.chunksProcessed}/${progress.totalChunks} chunks`;
        case "storing":
          return "Indexing: saving index data";
        case "complete":
          return "Indexing complete";
      }
    })();

    void this.client.app.log({
      body: {
        service: "codebase-index",
        level: "info",
        message,
        extra: {
          phase: progress.phase,
          filesProcessed: progress.filesProcessed,
          totalFiles: progress.totalFiles,
          chunksProcessed: progress.chunksProcessed,
          totalChunks: progress.totalChunks,
          currentFiles: progress.currentFiles,
        },
      },
    }).catch(() => { /* best-effort */ });
  }

  private getIndexPath(): string {
    return resolveProjectIndexPath(this.projectRoot, this.config.scope);
  }

  private getScopedRoots(): string[] {
    const roots = new Set<string>([path.resolve(this.projectRoot)]);

    for (const kbRoot of this.config.knowledgeBases) {
      roots.add(path.resolve(this.projectRoot, kbRoot));
    }

    return Array.from(roots);
  }

  private getBranchCatalogKey(): string {
    const branchName = this.currentBranch || "default";
    if (this.config.scope !== "global") {
      return branchName;
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `${projectHash}:${branchName}`;
  }

  private getLegacyBranchCatalogKey(): string {
    return this.currentBranch || "default";
  }

  private getLegacyMigrationMetadataKey(): string {
    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `index.globalBranchMigration.${projectHash}`;
  }

  private getProjectEmbeddingStrategyMetadataKey(): string {
    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `index.embeddingStrategyVersion.${projectHash}`;
  }

  private getProjectForceReembedMetadataKey(): string {
    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `index.forceReembed.${projectHash}`;
  }

  private async hasProjectForceReembedPending(): Promise<boolean> {
    return this.config.scope === "global"
      && (await this.database?.getMetadata(this.getProjectForceReembedMetadataKey())) === "true";
  }

  private async hasScopedIndexedData(): Promise<boolean> {
    if (!this.store || this.config.scope !== "global") {
      return false;
    }

    if (await this.hasProjectForceReembedPending()) {
      return false;
    }

    const roots = this.getScopedRoots();
    const scopedFilePaths = await this.database?.getFilePathsInRoots(roots) ?? [];

    if (scopedFilePaths.length > 0) {
      return true;
    }

    if (this.loadSerializedFailedBatches().some((batch) =>
      batch.chunks.some((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath !== null && this.isFileInCurrentScope(filePath, roots);
      })
    )) {
      return true;
    }

    if (!this.database) {
      return false;
    }

    for (const branchKey of this.getBranchCatalogKeys()) {
      const branchChunkIds = await this.database!.getBranchChunkIds(branchKey);
      if (branchChunkIds.length > 0) {
        return true;
      }

      if ((await this.database!.getBranchSymbolIds(branchKey)).length > 0) {
        return true;
      }
    }

    const allBranches = await this.database.getAllBranches();
    const hasAnyBranchRows = await Promise.all(allBranches.map(async (branchKey) => {
      const branchChunkIds = await this.database!.getBranchChunkIds(branchKey);
      if (branchChunkIds.length > 0) {
        return true;
      }

      return (await this.database!.getBranchSymbolIds(branchKey)).length > 0;
    })).then((results) => results.some(Boolean));
    if (hasAnyBranchRows) {
      return false;
    }

    return (await this.store.getAllMetadata()).some(({ metadata }) => this.isFileInCurrentScope(metadata.filePath, roots));
  }

  private async loadStoredEmbeddingStrategyVersion(): Promise<string | null> {
    if (!this.database) {
      return null;
    }

    if (await this.hasProjectForceReembedPending()) {
      return null;
    }

    if (this.config.scope !== "global") {
      return (await this.database.getMetadata("index.embeddingStrategyVersion")) ?? "1";
    }

    const projectVersion = await this.database.getMetadata(this.getProjectEmbeddingStrategyMetadataKey());
    if (projectVersion) {
      return projectVersion;
    }

    const legacySharedVersion = await this.database.getMetadata("index.embeddingStrategyVersion");
    if (legacySharedVersion && await this.hasScopedIndexedData()) {
      return legacySharedVersion;
    }

    return null;
  }

  private getBranchCatalogKeys(): string[] {
    const primary = this.getBranchCatalogKey();
    if (this.config.scope !== "global") {
      return [primary];
    }

    if (this.branchMigrationDone) {
      return [primary];
    }

    const legacy = this.getLegacyBranchCatalogKey();
    return primary === legacy ? [primary] : [primary, legacy];
  }

  private getBranchCatalogCleanupKeys(): string[] {
    const primary = this.getBranchCatalogKey();
    if (this.config.scope !== "global") {
      return [primary];
    }

    const legacy = this.getLegacyBranchCatalogKey();
    return primary === legacy ? [primary] : [primary, legacy];
  }

  private async getProjectLocalScopedOwnershipIds(roots: string[]): Promise<{
    chunkIds: Set<string>;
    symbolIds: Set<string>;
  }> {
    const chunkIds = new Set<string>();
    const symbolIds = new Set<string>();
    if (!this.database) {
      return { chunkIds, symbolIds };
    }

    const projectRootPath = path.resolve(this.projectRoot);
    const scopedFilePaths = await this.database.getFilePathsInRoots(roots);
    const storeMetadata = this.store ? await this.store.getAllMetadata() : [];
    const projectLocalFilePaths = new Set<string>([
      ...scopedFilePaths.filter(
        (filePath) => this.isFileInCurrentScope(filePath, roots) && isPathWithinRoot(filePath, projectRootPath)
      ),
      ...storeMetadata
        .map(({ metadata }) => metadata.filePath)
        .filter(
          (filePath) => this.isFileInCurrentScope(filePath, roots) && isPathWithinRoot(filePath, projectRootPath)
        ),
    ]);

    for (const filePath of projectLocalFilePaths) {
      for (const chunk of await this.database.getChunksByFile(filePath)) {
        chunkIds.add(chunk.chunkId);
      }

      for (const symbol of await this.database.getSymbolsByFile(filePath)) {
        symbolIds.add(symbol.id);
      }
    }

    return { chunkIds, symbolIds };
  }

  private async getProjectScopedBranchCatalogCleanupKeys(projectChunkIds: string[], projectSymbolIds: string[]): Promise<string[]> {
    if (this.config.scope !== "global") {
      return this.getBranchCatalogCleanupKeys();
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    const keys = new Set<string>();
    const projectChunkIdSet = new Set(projectChunkIds);
    const projectSymbolIdSet = new Set(projectSymbolIds);

    for (const branchKey of await (this.database?.getAllBranches() ?? Promise.resolve([]))) {
      if (branchKey.startsWith(`${projectHash}:`)) {
        keys.add(branchKey);
        continue;
      }

      if (branchKey.includes(":")) {
        continue;
      }

      const referencesProjectChunks = (await this.database?.getBranchChunkIds(branchKey) ?? []).some((chunkId) => projectChunkIdSet.has(chunkId));
      const referencesProjectSymbols = (await this.database?.getBranchSymbolIds(branchKey) ?? []).some((symbolId) => projectSymbolIdSet.has(symbolId));
      if (referencesProjectChunks || referencesProjectSymbols) {
        keys.add(branchKey);
      }
    }

    for (const branchKey of this.getBranchCatalogCleanupKeys()) {
      keys.add(branchKey);
    }

    return Array.from(keys);
  }

  private isFileInCurrentScope(filePath: string, roots: string[]): boolean {
    return roots.some((root) => isPathWithinRoot(filePath, root));
  }

  private computeSourceId(rootPath: string): string {
    return createHash("sha256").update(rootPath).digest("hex").slice(0, 32);
  }

  private async clearScopedFileHashCache(roots: string[]): Promise<void> {
    for (const root of roots) {
      await this.database!.deleteFileHashesBySource(this.computeSourceId(root));
    }
  }

  private async replaceScopedFileHashCache(currentFileHashes: Map<string, string>, roots: string[]): Promise<void> {
    for (const root of roots) {
      await this.database!.deleteFileHashesBySource(this.computeSourceId(root));
    }
    await this.database!.setFileHashesBatch(currentFileHashes, this.computeSourceId(this.projectRoot));
  }

  private partitionFailedBatches(roots: string[], maxChunkTokens?: number): { scoped: FailedBatch[]; retained: SerializedFailedBatch[] } {
    const scoped: FailedBatch[] = [];
    const retained: SerializedFailedBatch[] = [];

    for (const batch of this.loadSerializedFailedBatches()) {
      const scopedChunks = batch.chunks.filter((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath !== null && this.isFileInCurrentScope(filePath, roots);
      });
      const retainedChunks = batch.chunks.filter((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath === null || !this.isFileInCurrentScope(filePath, roots);
      });

      if (scopedChunks.length > 0) {
        const normalizedBatch = normalizeFailedBatch({ ...batch, chunks: scopedChunks }, maxChunkTokens);
        if (normalizedBatch) {
          scoped.push(normalizedBatch);
        }
      }

      if (retainedChunks.length > 0) {
        retained.push({ ...batch, chunks: retainedChunks });
      }
    }

    return { scoped, retained };
  }

  private clearScopedFailedBatches(roots: string[]): void {
    const { retained: retainedBatches } = this.partitionFailedBatches(roots);
    this.saveFailedBatches(retainedBatches);
  }

  private async hasForeignScopedFileHashData(roots: string[]): Promise<boolean> {
    return this.database!.hasSourcesOtherThan(roots.map(r => this.computeSourceId(r)));
  }

  private hasForeignScopedFailedBatches(roots: string[]): boolean {
    const { retained } = this.partitionFailedBatches(roots);
    return retained.length > 0;
  }

  private async hasForeignScopedBranchData(): Promise<boolean> {
    if (!this.database || this.config.scope !== "global") {
      return false;
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    const roots = this.getScopedRoots();
    const { chunkIds: projectLocalChunkIds, symbolIds: projectLocalSymbolIds } = await this.getProjectLocalScopedOwnershipIds(roots);

    const branchKeys = await this.database.getAllBranches();
    return (await Promise.all(branchKeys.map(async (branchKey) => {
        const branchChunkIds = await this.database!.getBranchChunkIds(branchKey);
        const branchSymbolIds = await this.database!.getBranchSymbolIds(branchKey);
        const hasBranchData = branchChunkIds.length > 0 || branchSymbolIds.length > 0;
        if (!hasBranchData) {
          return false;
        }

        if (branchKey.startsWith(`${projectHash}:`)) {
          return false;
        }

        if (!branchKey.includes(":")) {
          const referencesCurrentProjectChunks = branchChunkIds.some((chunkId) => projectLocalChunkIds.has(chunkId));
          const referencesCurrentProjectSymbols = branchSymbolIds.some((symbolId) => projectLocalSymbolIds.has(symbolId));
          return !(referencesCurrentProjectChunks || referencesCurrentProjectSymbols);
        }

        return true;
      }
    ))).some(Boolean);
  }

  private saveScopedFailedBatches(batches: FailedBatch[], roots: string[]): void {
    const { retained } = this.partitionFailedBatches(roots);
    this.saveFailedBatches([...retained, ...batches]);
  }

  private async clearSharedIndexProjectData(
    store: IVectorStoreBackend,
    invertedIndex: InvertedIndex,
    database: IDatabaseBackend,
    roots: string[]
  ): Promise<{ removedChunkIds: string[]; hasForeignData: boolean }> {
    const allMetadata = await store.getAllMetadata();
    const scopedEntries = allMetadata.filter(({ metadata }) => this.isFileInCurrentScope(metadata.filePath, roots));

    // Collect file paths from all scoped sources + vector store metadata
    const filePaths = new Set<string>(scopedEntries.map(({ metadata }) => metadata.filePath));
    for (const root of roots) {
      for (const fp of await this.database!.getFilePathsBySource(this.computeSourceId(root))) {
        filePaths.add(fp);
      }
    }

    const projectRootPath = path.resolve(this.projectRoot);
    const projectLocalFilePaths = new Set<string>(
      Array.from(filePaths).filter((filePath) => isPathWithinRoot(filePath, projectRootPath))
    );

    const removedChunkIds = new Set<string>(scopedEntries.map(({ key }) => key));
    for (const filePath of filePaths) {
      for (const chunk of await database.getChunksByFile(filePath)) {
        removedChunkIds.add(chunk.chunkId);
      }
    }
    const removedChunkIdList = Array.from(removedChunkIds);

    const projectLocalChunkIds = new Set<string>(
      scopedEntries
        .filter(({ metadata }) => isPathWithinRoot(metadata.filePath, projectRootPath))
        .map(({ key }) => key)
    );
    for (const filePath of projectLocalFilePaths) {
      for (const chunk of await database.getChunksByFile(filePath)) {
        projectLocalChunkIds.add(chunk.chunkId);
      }
    }

    const symbolIds: string[] = [];
    const projectLocalSymbolIds = new Set<string>();
    for (const filePath of filePaths) {
      for (const symbol of await database.getSymbolsByFile(filePath)) {
        symbolIds.push(symbol.id);
        if (projectLocalFilePaths.has(filePath)) {
          projectLocalSymbolIds.add(symbol.id);
        }
      }
    }

    for (const branchKey of await this.getProjectScopedBranchCatalogCleanupKeys(Array.from(projectLocalChunkIds), Array.from(projectLocalSymbolIds))) {
      await database.deleteBranchChunksForBranch(branchKey, removedChunkIdList);
    }
    const sharedChunkIds = new Set(await database.getReferencedChunkIds(removedChunkIdList));
    const removableChunkIds = removedChunkIdList.filter((chunkId) => !sharedChunkIds.has(chunkId));

    for (const chunkId of removableChunkIds) {
      await store.remove(chunkId);
      invertedIndex.removeChunk(chunkId);
    }

    for (const branchKey of await this.getProjectScopedBranchCatalogCleanupKeys(Array.from(projectLocalChunkIds), Array.from(projectLocalSymbolIds))) {
      await database.deleteBranchSymbolsForBranch(branchKey, symbolIds);
    }
    const sharedSymbolIds = new Set(await database.getReferencedSymbolIds(symbolIds));
    const removableSymbolIds = symbolIds.filter((symbolId) => !sharedSymbolIds.has(symbolId));

    await database.clearCallEdgeTargetsForSymbols(removableSymbolIds);

    for (const filePath of filePaths) {
      const fileChunks = await database.getChunksByFile(filePath);
      const fileChunkIds = fileChunks.map((chunk) => chunk.chunkId);
      const fileSymbols = await database.getSymbolsByFile(filePath);

      if (fileChunkIds.every((chunkId) => !sharedChunkIds.has(chunkId))) {
        await database.deleteChunksByFile(filePath);
      }

      if (fileSymbols.every((symbol) => !sharedSymbolIds.has(symbol.id))) {
        await database.deleteCallEdgesByFile(filePath);
        await database.deleteSymbolsByFile(filePath);
      }
    }

    await database.gcOrphanCallEdges();
    await database.gcOrphanSymbols();
    await database.gcOrphanEmbeddings();
    await database.gcOrphanChunks();

    await store.save();
    await this.database!.saveInvertedIndex(invertedIndex.serialize());

    return {
      removedChunkIds: removedChunkIdList,
      hasForeignData: allMetadata.some(({ metadata }) => !this.isFileInCurrentScope(metadata.filePath, roots)),
    };
  }

  private async checkForInterruptedIndexing(): Promise<"none" | "stale" | "active"> {
    const lockInfo = await this.database!.getLockInfo();
    if (!lockInfo) return "none";
    if (!isPidAlive(lockInfo.pid)) return "stale";
    return "active";
  }

  private async acquireIndexingLock(): Promise<void> {
    const acquired = await this.database!.tryAcquireLock(process.pid, new Date().toISOString());
    if (!acquired) {
      throw new Error("[codebase-index] Another indexing session is already in progress");
    }
  }

  private async releaseIndexingLock(): Promise<void> {
    await this.database!.releaseLock();
  }

  private async recoverFromInterruptedIndexing(): Promise<void> {
    this.logger.warn("Detected stale lock from crashed/killed process, recovering...");
    await this.healthCheck();
    await this.releaseIndexingLock();
    this.logger.info("Lock cleared; previously completed file batches will be skipped on next index");
  }

  private loadFailedBatches(maxChunkTokens?: number): FailedBatch[] {
    try {
      return this.loadSerializedFailedBatches()
        .map((batch) => normalizeFailedBatch(batch, maxChunkTokens))
        .filter((batch): batch is FailedBatch => batch !== null);
    } catch {
      return [];
    }
  }

  private loadSerializedFailedBatches(): SerializedFailedBatch[] {
    if (!existsSync(this.failedBatchesPath)) {
      return [];
    }

    const data = readFileSync(this.failedBatchesPath, "utf-8");
    const parsed = JSON.parse(data) as Array<{
      chunks?: unknown[];
      error?: unknown;
      attemptCount?: unknown;
      lastAttempt?: unknown;
    }>;

    return parsed
      .map((batch) => {
        const chunks = Array.isArray(batch.chunks) ? batch.chunks : [];
        if (chunks.length === 0) {
          return null;
        }

        return {
          chunks,
          error: typeof batch.error === "string" ? batch.error : "Unknown embedding error",
          attemptCount: typeof batch.attemptCount === "number" ? batch.attemptCount : 1,
          lastAttempt: typeof batch.lastAttempt === "string" ? batch.lastAttempt : new Date().toISOString(),
        } satisfies SerializedFailedBatch;
      })
      .filter((batch): batch is SerializedFailedBatch => batch !== null);
  }

  private saveFailedBatches(batches: SerializedFailedBatch[]): void {
    if (batches.length === 0) {
      if (existsSync(this.failedBatchesPath)) {
        try {
          unlinkSync(this.failedBatchesPath);
        } catch {
          // Ignore cleanup failures; stale diagnostics are best-effort only.
        }
      }
      return;
    }
    writeFileSync(this.failedBatchesPath, JSON.stringify(batches, null, 2));
  }

  private collectRetryableFailedChunks(
    currentFileHashes: Map<string, string>,
    unchangedFilePaths: Set<string>,
    maxChunkTokens?: number
  ): RetryableFailedChunk[] {
    const retryableById = new Map<string, RetryableFailedChunk>();

    for (const batch of this.loadFailedBatches(maxChunkTokens)) {
      for (const chunk of batch.chunks) {
        const filePath = chunk.metadata.filePath;
        if (!currentFileHashes.has(filePath)) {
          continue;
        }
        if (!unchangedFilePaths.has(filePath)) {
          continue;
        }

        const existing = retryableById.get(chunk.id);
        if (!existing || batch.attemptCount > existing.attemptCount) {
          retryableById.set(chunk.id, {
            chunk,
            attemptCount: batch.attemptCount,
          });
        }
      }
    }

    return Array.from(retryableById.values());
  }

  private getProviderRateLimits(provider: string): {
    concurrency: number;
    intervalMs: number;
    minRetryMs: number;
    maxRetryMs: number;
  } {
    switch (provider) {
      case "github-copilot":
        return { concurrency: 1, intervalMs: 4000, minRetryMs: 5000, maxRetryMs: 60000 };
      case "openai":
        return { concurrency: 3, intervalMs: 500, minRetryMs: 1000, maxRetryMs: 30000 };
      case "google":
        return { concurrency: 5, intervalMs: 200, minRetryMs: 1000, maxRetryMs: 30000 };
      case "ollama":
        return { concurrency: 5, intervalMs: 0, minRetryMs: 500, maxRetryMs: 5000 };
      case "custom": {
        // Custom providers allow user-configurable concurrency and request interval.
        // Defaults are conservative (3 concurrent, 1s interval) for cloud endpoints;
        // users running local servers should set concurrency higher and intervalMs to 0.
        const customConfig = this.config.customProvider;
        return {
          concurrency: customConfig?.concurrency ?? 3,
          intervalMs: customConfig?.requestIntervalMs ?? 1000,
          minRetryMs: 1000,
          maxRetryMs: 30000,
        };
      }
      default:
        return { concurrency: 3, intervalMs: 1000, minRetryMs: 1000, maxRetryMs: 30000 };
    }
  }

  private async rerankCandidatesWithApi(
    query: string,
    candidates: RankedCandidate[],
    options?: {
      definitionIntent?: boolean;
      hasIdentifierHints?: boolean;
    }
  ): Promise<RankedCandidate[]> {
    const reranker = this.config.reranker;
    if (!reranker || !reranker.enabled || candidates.length <= 1) {
      return candidates;
    }

    const queryTokens = Array.from(tokenizeTextForRanking(query));
    const preferSourcePaths = classifyQueryIntentRaw(query) === "source";
    const docIntent = classifyDocIntent(queryTokens) === "docs";

    if (options?.definitionIntent === true) {
      return candidates;
    }

    if (options?.hasIdentifierHints === true && preferSourcePaths && !docIntent) {
      return candidates;
    }

    const topN = Math.min(reranker.topN, candidates.length);
    const head = candidates.slice(0, topN);
    const tail = candidates.slice(topN);
    const grouped = new Map<ExternalRerankBand, RankedCandidate[]>([
      ["implementation", []],
      ["documentation", []],
      ["test", []],
      ["other", []],
    ]);

    for (const candidate of head) {
      const band = classifyExternalRerankBand(candidate, preferSourcePaths, docIntent);
      grouped.get(band)?.push(candidate);
    }

    const orderedBands: ExternalRerankBand[] = preferSourcePaths
      ? ["implementation", "other", "documentation", "test"]
      : docIntent
        ? ["documentation", "implementation", "other", "test"]
        : ["implementation", "other", "documentation", "test"];

    try {
      const rerankedHead: RankedCandidate[] = [];
      for (const band of orderedBands) {
        const bandCandidates = grouped.get(band) ?? [];
        if (bandCandidates.length <= 1) {
          rerankedHead.push(...bandCandidates);
          continue;
        }

        const documents = await Promise.all(
          bandCandidates.map(async (candidate) => ({
            id: candidate.id,
            text: await this.createRerankerDocumentText(candidate),
          }))
        );
        const rankedIds = await this.callExternalReranker(query, documents, reranker);
        if (rankedIds.length === 0) {
          rerankedHead.push(...bandCandidates);
          continue;
        }

        const order = new Map(rankedIds.map((id, index) => [id, index]));
        const bandReranked = [...bandCandidates].sort((a, b) => {
          const aRank = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const bRank = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          if (aRank !== bRank) {
            return aRank - bRank;
          }
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return a.id.localeCompare(b.id);
        });
        const shouldDiversifyBand = !options?.hasIdentifierHints;
        rerankedHead.push(...diversifyCandidatesByFile(bandReranked, shouldDiversifyBand));
      }

      this.logger.search("debug", "Applied external reranker", {
        provider: reranker.provider,
        model: reranker.model,
        candidateCount: head.length,
        bands: orderedBands,
      });

      return [...rerankedHead, ...tail];
    } catch (error) {
      this.logger.search("warn", "External reranker failed; using deterministic order", {
        provider: reranker.provider,
        model: reranker.model,
        error: getErrorMessage(error),
      });
      return candidates;
    }
  }

  private async callExternalReranker(
    query: string,
    documents: RerankDocumentPayload[],
    reranker: RerankerConfig
  ): Promise<string[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (reranker.apiKey) {
      headers.Authorization = `Bearer ${reranker.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), reranker.timeoutMs);
    try {
      const response = await fetch(`${reranker.baseUrl}/rerank`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: reranker.model,
          query,
          documents: documents.map((document) => document.text),
          top_n: documents.length,
          return_documents: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Reranker API error: ${response.status} - ${await response.text()}`);
      }

      const body = await response.json() as {
        results?: Array<{ index?: number; relevance_score?: number }>;
      };
      if (!Array.isArray(body.results)) {
        throw new Error("Reranker API returned unexpected response format.");
      }

      return body.results
        .map((result) => {
          const index = typeof result.index === "number" ? result.index : -1;
          return documents[index]?.id;
        })
        .filter((id): id is string => typeof id === "string");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Reranker request timed out after ${reranker.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async createRerankerDocumentText(candidate: RankedCandidate): Promise<string> {
    const parts = [
      `path: ${candidate.metadata.filePath}`,
      `chunk_type: ${candidate.metadata.chunkType}`,
      `language: ${candidate.metadata.language}`,
      `lines: ${candidate.metadata.startLine}-${candidate.metadata.endLine}`,
    ];

    if (candidate.metadata.name) {
      parts.push(`name: ${candidate.metadata.name}`);
    }

    const intent = isLikelyImplementationPath(candidate.metadata.filePath) ? "implementation" : "doc_or_test";
    parts.push(`intent_hint: ${intent}`);

    try {
      const fileContent = await fsPromises.readFile(candidate.metadata.filePath, "utf-8");
      const lines = fileContent.split("\n");
      const snippetStartLine = Math.max(1, candidate.metadata.startLine - 2);
      const snippetEndLine = Math.min(lines.length, candidate.metadata.endLine + 2);
      const snippet = lines.slice(snippetStartLine - 1, snippetEndLine).join("\n").trim();
      parts.push("snippet:");
      parts.push(snippet.length > 0 ? snippet : "[empty]");
    } catch {
      parts.push("snippet:");
      parts.push("[unavailable]");
    }

    return parts.join("\n");
  }

  async initialize(client?: any): Promise<void> {
    this.client = client;

    if (this.config.embeddingProvider === 'custom') {
      if (!this.config.customProvider) {
        throw new Error("embeddingProvider is 'custom' but customProvider config is missing.");
      }
      this.configuredProviderInfo = createCustomProviderInfo(this.config.customProvider);
    } else if (this.config.embeddingProvider === 'auto') {
      this.configuredProviderInfo = await tryDetectProvider();
    } else {
      this.configuredProviderInfo = await detectEmbeddingProvider(this.config.embeddingProvider, this.config.embeddingModel);
    }

    if (!this.configuredProviderInfo) {
      throw new Error(
        "No embedding provider available. Configure GitHub Copilot, OpenAI, Google, Ollama, or a custom OpenAI-compatible endpoint."
      );
    }

    this.logger.info("Initializing indexer", {
      provider: this.configuredProviderInfo.provider,
      model: this.configuredProviderInfo.modelInfo.model,
      scope: this.config.scope,
      rerankerEnabled: this.config.reranker?.enabled ?? false,
    });

    this.provider = createEmbeddingProvider(this.configuredProviderInfo);

    // Initialize reranker if configured
    if (this.config.reranker?.enabled) {
      this.reranker = createReranker(this.config.reranker);
      if (this.reranker.isAvailable()) {
        this.logger.info("Reranker initialized", {
          model: this.config.reranker.model,
          baseUrl: this.config.reranker.baseUrl,
        });
      }
    }

    await fsPromises.mkdir(this.indexPath, { recursive: true });

    // NOTE: Interrupted indexing recovery is deferred until after store,
    // invertedIndex, and database are initialized (see below). Running it here
    // would cause infinite recursion: recovery → healthCheck → ensureInitialized
    // → initialize (store not yet set) → recovery → ...

    const dimensions = this.configuredProviderInfo.modelInfo.dimensions;
    const dbCfg = this.config.database;

    // ── Vector store ──────────────────────────────────────────────────────────
    this.store = await createVectorStoreBackend(dbCfg, this.indexPath, dimensions);
    await this.store.load();

    // ── Inverted index ────────────────────────────────────────────────────────
    const invertedIndexPath = path.join(this.indexPath, "inverted-index.json");
    this.invertedIndex = new InvertedIndex(invertedIndexPath);

    // ── Database ──────────────────────────────────────────────────────────────
    const dbPath = path.join(this.indexPath, "codebase.db");
    const dbIsNew = dbCfg.engine === "sqlite" && !existsSync(dbPath);

    // Log database connection details
    if (dbCfg.engine === "sqlite") {
      const msg = `Initializing SQLite database at ${dbPath}`;
      this.logger.info(msg, { path: dbPath, isNew: dbIsNew });
      if (client) {
        await client.app.log({
          body: {
            service: "codebase-index",
            level: "info",
            message: msg,
            extra: { path: dbPath, isNew: dbIsNew },
          },
        });
      }
    } else if (dbCfg.engine === "pgvector" && dbCfg.pgvector) {
      const pgConfig = dbCfg.pgvector;
      const connectionInfo = pgConfig.connectionString
        ? "via connection string"
        : `${pgConfig.user || "postgres"}@${pgConfig.host || "localhost"}:${pgConfig.port || 5432}/${pgConfig.database || "postgres"}`;
      const msg = `Initializing pgvector database ${connectionInfo}`;
      this.logger.info(msg, {
        connectionInfo,
        tablePrefix: pgConfig.tablePrefix || "ci",
        ssl: pgConfig.ssl || "disable",
      });
      if (client) {
        await client.app.log({
          body: {
            service: "codebase-index",
            level: "info",
            message: msg,
            extra: {
              connectionInfo,
              tablePrefix: pgConfig.tablePrefix || "ci",
              ssl: pgConfig.ssl || "disable",
            },
          },
        });
      }
    }

    try {
      this.database = await createDatabaseBackend(dbCfg, dbPath);
    } catch (error) {
      if (dbCfg.engine !== "sqlite" || !(await this.tryResetCorruptedIndex("initializing index database", error))) {
        throw error;
      }

      this.store = await createVectorStoreBackend(dbCfg, this.indexPath, dimensions);
      this.invertedIndex = new InvertedIndex(invertedIndexPath);
      this.database = await createDatabaseBackend(dbCfg, dbPath);
    }

    // Hydrate the in-memory inverted index from whichever backend owns it.
    try {
      const invertedIndexJson = await this.database.loadInvertedIndex();
      if (invertedIndexJson) {
        this.invertedIndex.deserialize(invertedIndexJson);
      }
    } catch {
      // Corrupted — will be rebuilt from scratch during next index run.
    }

    // Load the cached migration-done flag so getBranchCatalogKeys() stays synchronous.
    if (this.config.scope === "global") {
      const migVal = await this.database.getMetadata(this.getLegacyMigrationMetadataKey());
      this.branchMigrationDone = migVal === "done";
    }

    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
      this.logger.branch("info", "Detected git repository", {
        currentBranch: this.currentBranch,
        baseBranch: this.baseBranch,
      });
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
      this.logger.branch("debug", "Not a git repository, using default branch");
    }

    // Recover from interrupted indexing AFTER store, invertedIndex, and database
    // are all initialized. healthCheck() calls ensureInitialized() which checks
    // these fields — if they're not set, it re-enters initialize() causing infinite
    // recursion and 70GB+ memory usage.
    const lockState = await this.checkForInterruptedIndexing();
    if (lockState === "stale") {
      await this.recoverFromInterruptedIndexing();
    }

    if (dbIsNew && (await this.store.count()) > 0) {
      await this.migrateFromLegacyIndex();
    }

  this.indexCompatibility = await this.validateIndexCompatibility(this.configuredProviderInfo);
    if (!this.indexCompatibility.compatible) {
      this.logger.warn("Index compatibility issue detected", {
        reason: this.indexCompatibility.reason,
        storedMetadata: this.indexCompatibility.storedMetadata,
        configuredProviderInfo: this.configuredProviderInfo,
      });
    }

    // Auto-GC: Run garbage collection if enabled and interval has elapsed
    if (this.config.indexing.autoGc) {
      await this.maybeRunAutoGc();
    }
  }

  private async maybeRunAutoGc(): Promise<void> {
    if (!this.database) return;

    const lastGcTimestamp = await this.database.getMetadata("lastGcTimestamp");
    const now = Date.now();
    const intervalMs = this.config.indexing.gcIntervalDays * 24 * 60 * 60 * 1000;

    let shouldRunGc = false;
    if (!lastGcTimestamp) {
      // Never run GC before, run it now
      shouldRunGc = true;
    } else {
      const lastGcTime = parseInt(lastGcTimestamp, 10);
      if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
        shouldRunGc = true;
      }
    }

    if (shouldRunGc) {
      const result = await this.healthCheck();
      if (result.warning) {
        await this.database.setMetadata(STARTUP_WARNING_METADATA_KEY, result.warning);
      } else {
        await this.database.deleteMetadata(STARTUP_WARNING_METADATA_KEY);
      }
      await this.database.setMetadata("lastGcTimestamp", now.toString());
    }
  }

  private async maybeRunOrphanGc(): Promise<CorruptedIndexResetResult | null> {
    if (!this.database) return null;

    const stats = await this.database.getStats();
    if (!stats) return null;

    const orphanCount = stats.embeddingCount - stats.chunkCount;
    if (orphanCount > this.config.indexing.gcOrphanThreshold) {
      try {
        await this.database.gcOrphanEmbeddings();
        await this.database.gcOrphanChunks();
      } catch (error) {
        if (await this.tryResetCorruptedIndex("running automatic orphan garbage collection", error)) {
          return {
            resetCorruptedIndex: true,
            warning: this.getCorruptedIndexWarning(path.join(this.indexPath, "codebase.db")),
          };
        }
        throw error;
      }
      await this.database.setMetadata("lastGcTimestamp", Date.now().toString());
    }

    return null;
  }

  private getCorruptedIndexWarning(dbPath: string): string {
    if (this.config.scope === "global") {
      return `Detected a corrupted shared global SQLite index at ${dbPath}. Automatic repair is disabled for global scope because it may delete other projects' index data. Remove or repair the shared index manually, then rerun index_codebase with force=true.`;
    }

    return `Detected a corrupted local SQLite index at ${dbPath} and reset the local index. Run index_codebase to rebuild search data.`;
  }

  private async tryResetCorruptedIndex(stage: string, error: unknown): Promise<boolean> {
    if (!isSqliteCorruptionError(error)) {
      return false;
    }

    const dbPath = path.join(this.indexPath, "codebase.db");
    const warning = this.getCorruptedIndexWarning(dbPath);
    const errorMessage = getErrorMessage(error);

    if (this.config.scope === "global") {
      this.logger.error("Detected corrupted shared global index database", {
        stage,
        dbPath,
        error: errorMessage,
      });
      throw new Error(`${warning} Original SQLite error: ${errorMessage}`);
    }

    this.logger.warn("Detected corrupted local index database, resetting local index", {
      stage,
      dbPath,
      error: errorMessage,
    });

    await this.database?.close();
    this.store = null;
    this.invertedIndex = null;
    this.database?.close();
    this.database = null;
    this.indexCompatibility = null;

    const resetPaths = [
      path.join(this.indexPath, "codebase.db"),
      path.join(this.indexPath, "codebase.db-shm"),
      path.join(this.indexPath, "codebase.db-wal"),
      path.join(this.indexPath, "vectors.usearch"),
      path.join(this.indexPath, "inverted-index.json"),
      path.join(this.indexPath, "file-hashes.json"),
      path.join(this.indexPath, "failed-batches.json"),
      path.join(this.indexPath, "indexing.lock"),
      path.join(this.indexPath, "vectors"),
    ];

    await Promise.all(resetPaths.map(async (targetPath) => {
      try {
        await fsPromises.rm(targetPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup. The follow-up reinitialization will recreate what it needs.
      }
    }));

    await fsPromises.mkdir(this.indexPath, { recursive: true });
    return true;
  }

  private async migrateFromLegacyIndex(): Promise<void> {
    if (!this.store || !this.database) return;

    const allMetadata = await this.store.getAllMetadata();
    const chunkIds: string[] = [];
    const chunkDataBatch: ChunkData[] = [];

    for (const { key, metadata } of allMetadata) {
      const chunkData: ChunkData = {
        chunkId: key,
        contentHash: metadata.hash,
        filePath: metadata.filePath,
        startLine: metadata.startLine,
        endLine: metadata.endLine,
        nodeType: metadata.chunkType,
        name: metadata.name,
        language: metadata.language,
      };
      chunkDataBatch.push(chunkData);
      chunkIds.push(key);
    }

    if (chunkDataBatch.length > 0) {
      await this.database.upsertChunksBatch(chunkDataBatch);
    }
    await this.database.addChunksToBranchBatch(this.getBranchCatalogKey(), chunkIds, this.computeSourceId(this.projectRoot));
  }

  private async loadIndexMetadata(): Promise<IndexMetadata | null> {
    if (!this.database) return null;

    const version = await this.database.getMetadata("index.version");
    if (!version) return null;

    return {
      indexVersion: version,
      embeddingProvider: (await this.database.getMetadata("index.embeddingProvider")) ?? "",
      embeddingModel: (await this.database.getMetadata("index.embeddingModel")) ?? "",
      embeddingDimensions: parseInt((await this.database.getMetadata("index.embeddingDimensions")) ?? "0", 10),
      embeddingStrategyVersion: (await this.loadStoredEmbeddingStrategyVersion()) ?? EMBEDDING_STRATEGY_VERSION,
      createdAt: (await this.database.getMetadata("index.createdAt")) ?? "",
      updatedAt: (await this.database.getMetadata("index.updatedAt")) ?? "",
    };
  }

  private async saveIndexMetadata(provider: ConfiguredProviderInfo): Promise<void> {
    if (!this.database) return;

    const now = new Date().toISOString();
    const existingCreatedAt = await this.database.getMetadata("index.createdAt");
    const completeProjectEmbeddingStrategyReset = !(await this.hasProjectForceReembedPending());

    await this.database.setMetadata("index.version", INDEX_METADATA_VERSION);
    await this.database.setMetadata("index.embeddingProvider", provider.provider);
    await this.database.setMetadata("index.embeddingModel", provider.modelInfo.model);
    await this.database.setMetadata("index.embeddingDimensions", provider.modelInfo.dimensions.toString());
    if (this.config.scope === "global") {
      if (completeProjectEmbeddingStrategyReset) {
        await this.database.setMetadata(this.getProjectEmbeddingStrategyMetadataKey(), EMBEDDING_STRATEGY_VERSION);
      }
      await this.database.setMetadata(this.getLegacyMigrationMetadataKey(), "done");
      if (completeProjectEmbeddingStrategyReset) {
        await this.database.deleteMetadata(this.getProjectForceReembedMetadataKey());
      }
      this.branchMigrationDone = true;
    } else {
      await this.database.setMetadata("index.embeddingStrategyVersion", EMBEDDING_STRATEGY_VERSION);
    }
    await this.database.setMetadata("index.updatedAt", now);

    if (!existingCreatedAt) {
      await this.database.setMetadata("index.createdAt", now);
    }
  }

  private async validateIndexCompatibility(provider: ConfiguredProviderInfo): Promise<IndexCompatibility> {
    const storedMetadata = await this.loadIndexMetadata();

    if (!storedMetadata) {
      return { compatible: true };
    }

    const currentProvider = provider.provider;
    const currentModel = provider.modelInfo.model;
    const currentDimensions = provider.modelInfo.dimensions;

    if (storedMetadata.embeddingDimensions !== currentDimensions) {
      return {
        compatible: false,
        code: IncompatibilityCode.DIMENSION_MISMATCH,
        reason: `Dimension mismatch: index has ${storedMetadata.embeddingDimensions}D vectors (${storedMetadata.embeddingProvider}/${storedMetadata.embeddingModel}), but current provider uses ${currentDimensions}D (${currentProvider}/${currentModel}). Run index_codebase with force=true to rebuild.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingModel !== currentModel) {
      return {
        compatible: false,
        code: IncompatibilityCode.MODEL_MISMATCH,
        reason: `Model mismatch: index was built with "${storedMetadata.embeddingModel}", but current model is "${currentModel}". Embeddings are incompatible. Run index_codebase with force=true to rebuild.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingStrategyVersion !== EMBEDDING_STRATEGY_VERSION) {
      return {
        compatible: false,
        code: IncompatibilityCode.EMBEDDING_STRATEGY_MISMATCH,
        reason: `Embedding strategy mismatch: index was built with embedding strategy v${storedMetadata.embeddingStrategyVersion}, but the current code requires v${EMBEDDING_STRATEGY_VERSION}. Run index_codebase with force=true to rebuild cached embeddings.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingProvider !== currentProvider) {
      this.logger.warn("Provider changed", {
        storedProvider: storedMetadata.embeddingProvider,
        currentProvider,
      });
    }

    return {
      compatible: true,
      storedMetadata,
    };
  }

  async checkCompatibility(): Promise<IndexCompatibility> {
    if (!this.indexCompatibility) {
      if (!this.configuredProviderInfo) {
        throw new Error('No embedding provider info, you must initialize the indexer first.');
      }

      this.indexCompatibility = await this.validateIndexCompatibility(this.configuredProviderInfo);
    }
    return this.indexCompatibility;
  }

  private async ensureInitialized(): Promise<{
    store: IVectorStoreBackend;
    provider: EmbeddingProviderInterface;
    invertedIndex: InvertedIndex;
    configuredProviderInfo: ConfiguredProviderInfo;
    database: IDatabaseBackend;
  }> {
    if (!this.store || !this.provider || !this.invertedIndex || !this.configuredProviderInfo || !this.database) {
      await this.initialize();
    }
    return {
      store: this.store!,
      provider: this.provider!,
      invertedIndex: this.invertedIndex!,
      configuredProviderInfo: this.configuredProviderInfo!,
      database: this.database!,
    };
  }

  async estimateCost(): Promise<CostEstimate> {
    const { configuredProviderInfo } = await this.ensureInitialized();

    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files } = await collectFiles(
      this.projectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.config.knowledgeBases,
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory }
    );

    return createCostEstimate(files, configuredProviderInfo);
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    const { store, provider, invertedIndex, database, configuredProviderInfo } = await this.ensureInitialized();
    const scopedRoots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const branchCatalogKey = this.getBranchCatalogKey();
    const forceScopedReembed = scopedRoots !== null && (await database.getMetadata(this.getProjectForceReembedMetadataKey())) === "true";
    const failedForcedChunkIds = new Set<string>();

    if (!this.indexCompatibility?.compatible) {
      throw new Error(
        `${this.indexCompatibility?.reason} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    await this.acquireIndexingLock();
    const sourceId = this.computeSourceId(this.projectRoot);
    // Clear any stale progress snapshot from a previous run
    void database.deleteMetadata(PROGRESS_SNAPSHOT_KEY).catch(() => { /* best-effort */ });
    this.embeddingPhaseStartTime = 0;
    this.embeddingChunksAtStart = 0;
    this.lastProgressPersistAt = 0;
    let lastCheckpointAt = 0;
    this.logger.recordIndexingStart();
    this.logger.info("Starting indexing", { projectRoot: this.projectRoot });

    const startTime = Date.now();
    const stats: IndexStats = {
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };
    const failedBatchesForCurrentRun: FailedBatch[] = [];
    const failedChunkIdsThisRun = new Set<string>();
    const failedAttemptCountByChunk = new Map<string, number>();
    const retryableChunksWithExistingData = new Set<string>();

    this.updateProgress({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    }, onProgress);

    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files, skipped } = await collectFiles(
      this.projectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.config.knowledgeBases,
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory }
    );

    stats.totalFiles = files.length;
    stats.skippedFiles = skipped;

    this.logger.recordFilesScanned(files.length);
    this.logger.cache("debug", "Scanning files for changes", {
      totalFiles: files.length,
      skippedFiles: skipped.length,
    });

    // Fetch only the hashes for files we are about to scan — avoids a full
    // table load and skips stale records for deleted or out-of-scope files.
    const storedHashes = await this.database!.getFileHashBatch(files.map((f) => f.path), sourceId);

    // Phase 1: Hash scan — classify files without reading content
    const changedFileMeta: Array<{ path: string; hash: string }> = [];
    const unchangedFilePaths: string[] = [];
    const unchangedFilePathSet = new Set<string>();
    const currentFileHashes = new Map<string, string>();
    const currentFilePathSet = new Set<string>(files.map(f => f.path));

    for (const f of files) {
      const currentHash = hashFile(f.path);
      currentFileHashes.set(f.path, currentHash);
      if (storedHashes.get(f.path) === currentHash) {
        if (forceScopedReembed) {
          changedFileMeta.push({ path: f.path, hash: currentHash });
          this.logger.recordCacheMiss();
        } else {
          unchangedFilePaths.push(f.path);
          unchangedFilePathSet.add(f.path);
          this.logger.recordCacheHit();
        }
      } else {
        changedFileMeta.push({ path: f.path, hash: currentHash });
        this.logger.recordCacheMiss();
      }
    }

    this.logger.cache("info", "File hash cache results", {
      unchanged: unchangedFilePaths.length,
      changed: changedFileMeta.length,
    });

    // Phase 2: Deleted file cleanup — remove chunks for files no longer on disk
    let removedCount = 0;
    const allChunkFilePaths = await this.database!.getChunkFilePaths(sourceId);
    for (const fp of allChunkFilePaths) {
      if (!currentFilePathSet.has(fp)) {
        if (scopedRoots && !this.isFileInCurrentScope(fp, scopedRoots)) continue;
        const oldChunks = await this.database!.getChunksByFile(fp, sourceId);
        const oldChunkIds = oldChunks.map(c => c.chunkId);
        for (const chunkId of oldChunkIds) {
          await store.remove(chunkId);
          invertedIndex.removeChunk(chunkId);
          removedCount++;
        }
        await database.deleteInvertedIndexChunkBatch(oldChunkIds);
      }
    }

    // Phase 3: Branch catalog init — clear upfront, rebuild incrementally below
    await database.clearBranch(branchCatalogKey, sourceId);
    await database.clearBranchSymbols(branchCatalogKey, sourceId);

    // Phase 4: Unchanged files → branch catalog (batched, parallel DB reads)
    const FILE_BATCH_SIZE = this.config.indexing.fileBatchSize;
    for (let i = 0; i < unchangedFilePaths.length; i += FILE_BATCH_SIZE) {
      const batch = unchangedFilePaths.slice(i, i + FILE_BATCH_SIZE);
      const [chunkResults, symbolResults] = await Promise.all([
        Promise.all(batch.map(fp => this.database!.getChunksByFile(fp, sourceId))),
        Promise.all(batch.map(fp => this.database!.getSymbolsByFile(fp, sourceId))),
      ]);
      const batchChunkIds = chunkResults.flat().map(c => c.chunkId);
      const batchSymbolIds = symbolResults.flat().map(s => s.id);
      stats.existingChunks += batchChunkIds.length;
      if (batchChunkIds.length > 0) await database.addChunksToBranchBatch(branchCatalogKey, batchChunkIds, sourceId);
      if (batchSymbolIds.length > 0) await database.addSymbolsToBranchBatch(branchCatalogKey, batchSymbolIds, sourceId);
    }

    // Phase 5: Changed files — main batch loop
    const providerRateLimits = this.getProviderRateLimits(configuredProviderInfo.provider);
    const queue = new PQueue({
      concurrency: providerRateLimits.concurrency,
      interval: providerRateLimits.intervalMs,
      intervalCap: providerRateLimits.concurrency,
    });
    let rateLimitBackoffMs = 0;

    const embedPendingChunks = async (batchPendingChunks: PendingChunk[]): Promise<void> => {
      if (batchPendingChunks.length === 0) return;

      const allContentHashes = batchPendingChunks.map(c => c.contentHash);
      const missingHashes = new Set(await database.getMissingEmbeddings(allContentHashes));
      const chunksNeedingEmbedding = forceScopedReembed
        ? batchPendingChunks
        : batchPendingChunks.filter(c => missingHashes.has(c.contentHash));
      const chunksWithExistingEmbedding = forceScopedReembed
        ? []
        : batchPendingChunks.filter(c => !missingHashes.has(c.contentHash));

      this.logger.cache("info", "Embedding cache lookup", {
        needsEmbedding: chunksNeedingEmbedding.length,
        fromCache: chunksWithExistingEmbedding.length,
      });
      this.logger.recordChunksFromCache(chunksWithExistingEmbedding.length);

      const existingEmbeddingEntries: Array<{ chunkId: string; content: string }> = [];
      for (const chunk of chunksWithExistingEmbedding) {
        const embeddingBuffer = await database.getEmbedding(chunk.contentHash);
        if (embeddingBuffer) {
          const vector = bufferToFloat32Array(embeddingBuffer);
          await store.add(chunk.id, Array.from(vector), chunk.metadata);
          invertedIndex.removeChunk(chunk.id);
          invertedIndex.addChunk(chunk.id, chunk.content);
          existingEmbeddingEntries.push({ chunkId: chunk.id, content: chunk.content });
          stats.indexedChunks++;
        }
      }
      await database.upsertInvertedIndexChunkBatch(existingEmbeddingEntries);

      const pendingChunksById = new Map(chunksNeedingEmbedding.map((c) => [c.id, c]));
      const embeddingPartsByChunk = new Map<string, Array<{ vector: number[]; tokenCount: number } | undefined>>();
      const requestBatches = createPendingEmbeddingRequestBatches(chunksNeedingEmbedding, getDynamicBatchOptions(configuredProviderInfo));
      for (const requestBatch of requestBatches) {
        queue.add(async () => {
          if (rateLimitBackoffMs > 0) {
            await new Promise(resolve => setTimeout(resolve, rateLimitBackoffMs));
          }
          try {
            const result = await pRetry(
              async () => {
                return provider.embedBatch(requestBatch.map((request) => request.text));
              },
              {
                retries: this.config.indexing.retries,
                minTimeout: Math.max(this.config.indexing.retryDelayMs, providerRateLimits.minRetryMs),
                maxTimeout: providerRateLimits.maxRetryMs,
                factor: 2,
                shouldRetry: (error) => !((error as { error?: Error }).error instanceof CustomProviderNonRetryableError),
                onFailedAttempt: (error) => {
                  const message = getErrorMessage(error);
                  if (isRateLimitError(error)) {
                    rateLimitBackoffMs = Math.min(providerRateLimits.maxRetryMs, (rateLimitBackoffMs || providerRateLimits.minRetryMs) * 2);
                    this.logger.embedding("warn", `Rate limited, backing off`, {
                      attempt: error.attemptNumber,
                      retriesLeft: error.retriesLeft,
                      backoffMs: rateLimitBackoffMs,
                    });
                  } else {
                    this.logger.embedding("error", `Embedding batch failed`, {
                      attempt: error.attemptNumber,
                      error: message,
                    });
                  }
                },
              }
            );

            if (rateLimitBackoffMs > 0) {
              rateLimitBackoffMs = Math.max(0, rateLimitBackoffMs - 2000);
            }

            const touchedChunkIds = new Set<string>();
            requestBatch.forEach((request, idx) => {
              const vector = result.embeddings[idx];
              if (!vector) return;
              const parts = embeddingPartsByChunk.get(request.chunk.id) ?? [];
              parts[request.partIndex] = { vector, tokenCount: request.tokenCount };
              embeddingPartsByChunk.set(request.chunk.id, parts);
              touchedChunkIds.add(request.chunk.id);
            });

            const pooledResults: Array<{ chunk: PendingChunk; vector: number[] }> = [];
            for (const chunkId of touchedChunkIds) {
              const chunk = pendingChunksById.get(chunkId);
              if (!chunk) continue;
              const parts = embeddingPartsByChunk.get(chunk.id) ?? [];
              if (!hasAllEmbeddingParts(parts, chunk.texts.length)) continue;
              const orderedParts = parts as Array<{ vector: number[]; tokenCount: number }>;
              pooledResults.push({
                chunk,
                vector: poolEmbeddingVectors(
                  orderedParts.map((p) => p.vector),
                  orderedParts.map((p) => p.tokenCount),
                ),
              });
              embeddingPartsByChunk.delete(chunkId);
            }
            await database.upsertInvertedIndexChunkBatch(
              pooledResults.map(({ chunk }) => ({ chunkId: chunk.id, content: chunk.content }))
            );

            if (pooledResults.length > 0) {
              const items = pooledResults.map(({ chunk, vector }) => ({
                id: chunk.id,
                vector,
                metadata: chunk.metadata,
              }));
              await store.addBatch(items);

              const embeddingBatchItems = pooledResults.map(({ chunk, vector }) => ({
                contentHash: chunk.contentHash,
                embedding: float32ArrayToBuffer(vector),
                chunkText: chunk.storageText,
                model: configuredProviderInfo.modelInfo.model,
              }));
              try {
                await database.upsertEmbeddingsBatch(embeddingBatchItems);
              } catch (dbError) {
                // Roll back vectors that were inserted before DB persistence failed.
                for (const { chunk } of pooledResults) {
                  await store.remove(chunk.id);
                }
                throw dbError;
              }

              for (const { chunk } of pooledResults) {
                invertedIndex.removeChunk(chunk.id);
                invertedIndex.addChunk(chunk.id, chunk.content);
              }

              stats.indexedChunks += pooledResults.length;
              this.logger.recordChunksEmbedded(pooledResults.length);
            }

            stats.tokensUsed += result.totalTokensUsed;
            this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
            this.logger.embedding("debug", `Embedded batch`, {
              batchSize: pooledResults.length,
              requestCount: requestBatch.length,
              tokens: result.totalTokensUsed,
            });

            this.updateProgress({
              phase: "embedding",
              filesProcessed: files.length,
              totalFiles: files.length,
              chunksProcessed: stats.indexedChunks,
              totalChunks: stats.totalChunks,
              currentFiles: [...new Set(requestBatch.map(r => r.chunk.metadata.filePath))],
            }, onProgress);
          } catch (error) {
            const failedChunks = getUniquePendingChunksFromRequests(requestBatch);
            const failureMessage = getErrorMessage(error);
            const failureTimestamp = new Date().toISOString();

            for (const chunk of failedChunks) {
              const previousAttemptCount = failedAttemptCountByChunk.get(chunk.id) ?? 0;
              const nextAttemptCount = previousAttemptCount + 1;
              failedAttemptCountByChunk.set(chunk.id, nextAttemptCount);

              if (!failedChunkIdsThisRun.has(chunk.id)) {
                if (!retryableChunksWithExistingData.has(chunk.id)) {
                  failedChunkIdsThisRun.add(chunk.id);
                }
                stats.failedChunks += 1;
              }
              if (forceScopedReembed) {
                failedForcedChunkIds.add(chunk.id);
              }

              const existingFailedBatchIndex = failedBatchesForCurrentRun.findIndex(
                (failedBatch) => failedBatch.chunks[0]?.id === chunk.id
              );
              const failedBatch = {
                chunks: [chunk],
                error: failureMessage,
                attemptCount: nextAttemptCount,
                lastAttempt: failureTimestamp,
              } satisfies FailedBatch;

              if (existingFailedBatchIndex === -1) {
                failedBatchesForCurrentRun.push(failedBatch);
              } else {
                failedBatchesForCurrentRun[existingFailedBatchIndex] = failedBatch;
              }
            }
            this.logger.recordEmbeddingError();
            this.logger.embedding("error", `Failed to embed batch after retries`, {
              batchSize: requestBatch.length,
              error: failureMessage,
            });
          }
        });
      }

      await queue.onIdle();
    };

    this.updateProgress({
      phase: "parsing",
      filesProcessed: 0,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    }, onProgress);

    for (let batchStart = 0; batchStart < changedFileMeta.length; batchStart += FILE_BATCH_SIZE) {
      const fileBatch = changedFileMeta.slice(batchStart, batchStart + FILE_BATCH_SIZE);

      this.updateProgress({
        phase: "parsing",
        filesProcessed: Math.min(batchStart, files.length),
        totalFiles: files.length,
        chunksProcessed: stats.indexedChunks,
        totalChunks: stats.totalChunks,
        currentFiles: fileBatch.map(f => f.path),
        batchStarting: true,
      }, onProgress);

      // Read content for only this batch
      const fileInputs = await Promise.all(
        fileBatch.map(async ({ path: fp, hash }) => ({
          path: fp,
          hash,
          content: await fsPromises.readFile(fp, "utf-8"),
        }))
      );

      const parseStartTime = performance.now();
      const parsedBatch = parseFiles(fileInputs);
      const parseMs = performance.now() - parseStartTime;

      this.logger.recordFilesParsed(parsedBatch.length);
      this.logger.recordParseDuration(parseMs);
      this.logger.debug("Parsed changed files batch", { parsedCount: parsedBatch.length, parseMs: parseMs.toFixed(2) });

      const contentByPath = new Map(fileInputs.map(f => [f.path, f.content]));
      const batchPendingChunks: PendingChunk[] = [];
      const batchChunkIds: string[] = [];
      const batchSymbolIds: string[] = [];

      for (const parsed of parsedBatch) {
        if (parsed.chunks.length === 0) {
          stats.parseFailures.push(path.relative(this.projectRoot, parsed.path));
        }

        let chunksToProcess = parsed.chunks;
        if (this.config.indexing.fallbackToTextOnMaxChunks && chunksToProcess.length > this.config.indexing.maxChunksPerFile) {
          const content = contentByPath.get(parsed.path);
          if (content) {
            chunksToProcess = parseFileAsText(parsed.path, content);
          }
        }

        // Per-file existing chunk lookup replaces the global existingChunks Map
        const existingFileChunks = await this.database!.getChunksByFile(parsed.path, sourceId);
        const existingChunkHashes = new Map(existingFileChunks.map(c => [c.chunkId, c.contentHash]));
        const newChunkIdsForFile = new Set<string>();
        const chunkDataForFile: ChunkData[] = [];

        let fileChunkCount = 0;
        for (const chunk of chunksToProcess) {
          if (fileChunkCount >= this.config.indexing.maxChunksPerFile) break;
          if (this.config.indexing.semanticOnly && chunk.chunkType === "other") continue;

          const id = generateChunkId(parsed.path, chunk);
          const contentHash = generateChunkHash(chunk);
          newChunkIdsForFile.add(id);
          batchChunkIds.push(id);
          chunkDataForFile.push({
            chunkId: id,
            contentHash,
            filePath: parsed.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            nodeType: chunk.chunkType,
            name: chunk.name,
            language: chunk.language,
          });

          if (!forceScopedReembed && existingChunkHashes.get(id) === contentHash) {
            stats.existingChunks++;
          } else {
            const texts = createEmbeddingTexts(chunk, parsed.path, getSafeEmbeddingChunkTokenLimit(configuredProviderInfo)).map((text) => ({
              text,
              tokenCount: estimateTokens(text),
            }));
            const metadata: ChunkMetadata = {
              filePath: parsed.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              chunkType: chunk.chunkType,
              name: chunk.name,
              language: chunk.language,
              hash: contentHash,
            };
            batchPendingChunks.push({ id, texts, storageText: createPendingChunkStorageText(texts), content: chunk.content, contentHash, metadata });
          }
          fileChunkCount++;
        }

        if (chunkDataForFile.length > 0) {
          await this.database!.upsertChunksBatch(chunkDataForFile, sourceId);
        }

        // Per-file orphan removal (chunks no longer produced by re-parsing)
        const orphanedChunkIds: string[] = [];
        for (const [oldChunkId] of existingChunkHashes) {
          if (!newChunkIdsForFile.has(oldChunkId)) {
            await store.remove(oldChunkId);
            invertedIndex.removeChunk(oldChunkId);
            orphanedChunkIds.push(oldChunkId);
            removedCount++;
          }
        }
        if (orphanedChunkIds.length > 0) {
          await database.deleteInvertedIndexChunkBatch(orphanedChunkIds);
        }

        // Call graph extraction for this file
        await database.deleteCallEdgesByFile(parsed.path, sourceId);
        await database.deleteSymbolsByFile(parsed.path, sourceId);
        const fileSymbols: SymbolData[] = [];
        for (const chunk of parsed.chunks) {
          if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
          const symbolId = `sym_${hashContent(parsed.path + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`;
          fileSymbols.push({
            id: symbolId,
            filePath: parsed.path,
            name: chunk.name,
            kind: chunk.chunkType,
            startLine: chunk.startLine,
            startCol: 0,
            endLine: chunk.endLine,
            endCol: 0,
            language: chunk.language,
          });
          batchSymbolIds.push(symbolId);
        }

        const symbolsByName = new Map<string, SymbolData[]>();
        for (const sym of fileSymbols) {
          const existing = symbolsByName.get(sym.name) ?? [];
          existing.push(sym);
          symbolsByName.set(sym.name, existing);
        }

        if (fileSymbols.length > 0) {
          await database.upsertSymbolsBatch(fileSymbols, sourceId);
        }

        const fileLanguage = parsed.chunks[0]?.language;
        const isCaseInsensitiveLanguage = !!fileLanguage && CASE_INSENSITIVE_LANGUAGES.has(fileLanguage);
        if (isCaseInsensitiveLanguage) {
          // Re-key symbolsByName with lowercased keys for case-insensitive languages (e.g. Apex).
          // The Rust call extractor already lowercases callee names for these languages,
          // so the symbol map must use the same casing or same-file calls won't resolve.
          symbolsByName.clear();
          for (const sym of fileSymbols) {
            const key = sym.name.toLowerCase();
            const existing = symbolsByName.get(key) ?? [];
            existing.push(sym);
            symbolsByName.set(key, existing);
          }
        }
        if (fileLanguage && CALL_GRAPH_LANGUAGES.has(fileLanguage)) {
          const content = contentByPath.get(parsed.path);
          if (content) {
            const callSites = extractCalls(content, fileLanguage);
            if (callSites.length > 0) {
              const edges: CallEdgeData[] = [];
              for (const site of callSites) {
                const enclosingSymbol = fileSymbols.find(
                  sym => site.line >= sym.startLine && site.line <= sym.endLine
                );
                if (!enclosingSymbol) continue;
                const edgeId = `edge_${hashContent(enclosingSymbol.id + ":" + site.calleeName + ":" + site.line + ":" + site.column).slice(0, 16)}`;
                edges.push({
                  id: edgeId,
                  fromSymbolId: enclosingSymbol.id,
                  targetName: site.calleeName,
                  toSymbolId: undefined,
                  callType: site.callType,
                  line: site.line,
                  col: site.column,
                  isResolved: false,
                });
              }
              if (edges.length > 0) {
                await database.upsertCallEdgesBatch(edges, sourceId);
                for (const edge of edges) {
                  const lookupKey = isCaseInsensitiveLanguage ? edge.targetName.toLowerCase() : edge.targetName;
                  const candidates = symbolsByName.get(lookupKey);
                  if (candidates && candidates.length === 1) {
                    await database.resolveCallEdge(edge.id, candidates[0].id);
                  }
                }
              }
            }
          }
        }
      }

      // Incremental branch catalog update for this file batch
      if (batchChunkIds.length > 0) await database.addChunksToBranchBatch(branchCatalogKey, batchChunkIds, sourceId);
      if (batchSymbolIds.length > 0) await database.addSymbolsToBranchBatch(branchCatalogKey, batchSymbolIds, sourceId);
      stats.totalChunks += batchPendingChunks.length;

      // Embed this batch; queue.onIdle() ensures we don't accumulate unbounded pending chunks
      await embedPendingChunks(batchPendingChunks);

      // Write hashes for this batch immediately so crash recovery can skip already-processed files
      await this.database!.setFileHashesBatch(new Map(fileBatch.map(f => [f.path, f.hash])), sourceId);

      // Periodically flush the vector store so crash recovery can skip already-processed files
      // without re-adding their vectors. store.save() is a no-op for pgvector (already durable).
      // The inverted index is kept current per-chunk via upsertInvertedIndexChunkBatch above.
      const now = Date.now();
      if (now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        lastCheckpointAt = now;
        await store.save();
        this.logger.debug("Checkpoint: flushed vector store");
      }

      this.updateProgress({
        phase: "parsing",
        filesProcessed: Math.min(batchStart + fileBatch.length, files.length),
        totalFiles: files.length,
        chunksProcessed: stats.indexedChunks,
        totalChunks: stats.totalChunks,
        currentFiles: fileBatch.map(f => f.path),
      }, onProgress);
      // fileInputs, parsedBatch, batchPendingChunks go out of scope → GC reclaims
    }

    // Phase 6: Retryable failed chunks from previous incomplete runs
    const retryableFailedChunks = this.collectRetryableFailedChunks(currentFileHashes, unchangedFilePathSet);
    if (retryableFailedChunks.length > 0) {
      const sourceBranchChunkIds = new Set(await database.getBranchChunkIds(branchCatalogKey, [sourceId]));
      for (const retryable of retryableFailedChunks) {
        if (sourceBranchChunkIds.has(retryable.chunk.id)) {
          retryableChunksWithExistingData.add(retryable.chunk.id);
        }
      }
      stats.totalChunks += retryableFailedChunks.length;
      await embedPendingChunks(retryableFailedChunks.map((r) => r.chunk));
    }

    this.logger.recordChunksProcessed(stats.totalChunks + stats.existingChunks);
    this.logger.recordChunksRemoved(removedCount);
    this.logger.info("Chunk analysis complete", {
      pending: stats.totalChunks,
      existing: stats.existingChunks,
      removed: removedCount,
    });

    // Phase 7: Finalization
    stats.removedChunks = removedCount;

    const coalescedFailedBatches = coalesceFailedBatches(failedBatchesForCurrentRun);
    if (scopedRoots) {
      this.saveScopedFailedBatches(coalescedFailedBatches, scopedRoots);
    } else {
      this.saveFailedBatches(coalescedFailedBatches);
    }

    // Remove chunks that failed embedding from the current source's branch catalog.
    if (failedChunkIdsThisRun.size > 0) {
      const sourceBranchChunkIds = new Set(await database.getBranchChunkIds(branchCatalogKey, [sourceId]));
      for (const failedChunkId of failedChunkIdsThisRun) {
        sourceBranchChunkIds.delete(failedChunkId);
      }
      await database.clearBranch(branchCatalogKey, sourceId);
      if (sourceBranchChunkIds.size > 0) {
        await database.addChunksToBranchBatch(branchCatalogKey, Array.from(sourceBranchChunkIds), sourceId);
      }
    }

    if (failedBatchesForCurrentRun.length > 0) {
      this.logger.embedding("warn", "Persisted failed embedding batches for later retry", {
        failedBatchCount: coalescedFailedBatches.length,
        failedChunks: stats.failedChunks,
        failedBatchesPath: this.failedBatchesPath,
      });
    }

    this.updateProgress({
      phase: "storing",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: stats.totalChunks,
    }, onProgress);

    if (stats.indexedChunks > 0 || removedCount > 0) {
      await store.save();
      await this.database!.saveInvertedIndex(invertedIndex.serialize());
    }

    if (scopedRoots) {
      await this.replaceScopedFileHashCache(currentFileHashes, scopedRoots);
    } else {
      await this.database!.replaceAllFileHashes(currentFileHashes, sourceId);
    }

    // Auto-GC after indexing: check if orphan count exceeds threshold
    if (this.config.indexing.autoGc && stats.removedChunks > 0) {
      const gcReset = await this.maybeRunOrphanGc();
      if (gcReset) {
        stats.durationMs = Date.now() - startTime;
        stats.warning = gcReset.warning;
        stats.resetCorruptedIndex = true;

        this.logger.recordIndexingEnd();
        this.logger.warn("Indexing ended after resetting corrupted local index during automatic GC", {
          files: stats.totalFiles,
          indexed: stats.indexedChunks,
          existing: stats.existingChunks,
          removed: stats.removedChunks,
          failed: stats.failedChunks,
          tokens: stats.tokensUsed,
          durationMs: stats.durationMs,
        });

        return stats;
      }
    }

    stats.durationMs = Date.now() - startTime;

    await this.saveIndexMetadata(configuredProviderInfo);
    if (forceScopedReembed && failedForcedChunkIds.size === 0) {
      await database.deleteMetadata(this.getProjectForceReembedMetadataKey());
    }
    await this.saveIndexMetadata(configuredProviderInfo);
    this.indexCompatibility = { compatible: true };

    this.logger.recordIndexingEnd();
    this.logger.info("Indexing complete", {
      files: stats.totalFiles,
      indexed: stats.indexedChunks,
      existing: stats.existingChunks,
      removed: stats.removedChunks,
      failed: stats.failedChunks,
      tokens: stats.tokensUsed,
      durationMs: stats.durationMs,
    });

    if (stats.failedChunks > 0) {
      stats.failedBatchesPath = this.failedBatchesPath;
    }

    this.updateProgress({
      phase: "complete",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: stats.totalChunks,
    }, onProgress);

    this.currentProgress = undefined;
    this.lastProgressSnapshot = "";
    this.embeddingPhaseStartTime = 0;
    this.embeddingChunksAtStart = 0;
    this.lastProgressPersistAt = 0;
    // Clear persisted snapshot now that indexing is done
    void database.deleteMetadata(PROGRESS_SNAPSHOT_KEY).catch(() => { /* best-effort */ });

    await this.releaseIndexingLock();
    return stats;
  }

  private async getQueryEmbedding(query: string, provider: EmbeddingProviderInterface): Promise<number[]> {
    const now = Date.now();
    const cached = this.queryEmbeddingCache.get(query);

    if (cached && (now - cached.timestamp) < this.queryCacheTtlMs) {
      this.logger.cache("debug", "Query embedding cache hit (exact)", { query: query.slice(0, 50) });
      this.logger.recordQueryCacheHit();
      return cached.embedding;
    }

    const similarMatch = this.findSimilarCachedQuery(query, now);
    if (similarMatch) {
      this.logger.cache("debug", "Query embedding cache hit (similar)", {
        query: query.slice(0, 50),
        similarTo: similarMatch.key.slice(0, 50),
        similarity: similarMatch.similarity.toFixed(3),
      });
      this.logger.recordQueryCacheSimilarHit();
      return similarMatch.embedding;
    }

    this.logger.cache("debug", "Query embedding cache miss", { query: query.slice(0, 50) });
    this.logger.recordQueryCacheMiss();
    const { embedding, tokensUsed } = await provider.embedQuery(query);
    this.logger.recordEmbeddingApiCall(tokensUsed);

    if (this.queryEmbeddingCache.size >= this.maxQueryCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (oldestKey) {
        this.queryEmbeddingCache.delete(oldestKey);
      }
    }

    this.queryEmbeddingCache.set(query, { embedding, timestamp: now });
    return embedding;
  }

  private findSimilarCachedQuery(
    query: string,
    now: number
  ): { key: string; embedding: number[]; similarity: number } | null {
    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) return null;

    let bestMatch: { key: string; embedding: number[]; similarity: number } | null = null;

    for (const [cachedQuery, { embedding, timestamp }] of this.queryEmbeddingCache) {
      if ((now - timestamp) >= this.queryCacheTtlMs) continue;

      const cachedTokens = this.tokenize(cachedQuery);
      const similarity = this.jaccardSimilarity(queryTokens, cachedTokens);

      if (similarity >= this.querySimilarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { key: cachedQuery, embedding, similarity };
        }
      }
    }

    return bestMatch;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1)
    );
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return intersection / union;
  }

  async search(
    query: string,
    limit?: number,
    options?: {
      hybridWeight?: number;
      fileType?: string;
      directory?: string;
      chunkType?: string;
      contextLines?: number;
      filterByBranch?: boolean;
      metadataOnly?: boolean;
      definitionIntent?: boolean;
    }
  ): Promise<SearchResult[]> {
    const { store, provider, database } = await this.ensureInitialized();

    const compatibility = await this.checkCompatibility();
    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `A possible solution is to run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if ((await store.count()) === 0) {
      this.logger.search("debug", "Search on empty index", { query });
      return [];
    }

    const maxResults = limit ?? this.config.search.maxResults;
    const hybridWeight = options?.hybridWeight ?? this.config.search.hybridWeight;
    const fusionStrategy = this.config.search.fusionStrategy;
    const rrfK = this.config.search.rrfK;
    const rerankTopN = this.config.search.rerankTopN;
    const filterByBranch = options?.filterByBranch ?? true;
    const sourceIntent = options?.definitionIntent === true || classifyQueryIntentRaw(query) === "source";
    const identifierHints = extractIdentifierHints(query);

    this.logger.search("debug", "Starting search", {
      query,
      maxResults,
      hybridWeight,
      fusionStrategy,
      rrfK,
      rerankTopN,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const embeddingQuery = stripFilePathHint(query);
    const embedding = await this.getQueryEmbedding(embeddingQuery, provider);
    const embeddingMs = performance.now() - embeddingStartTime;

    const vectorStartTime = performance.now();
    const semanticResults = await store.search(embedding, maxResults * 4);
    const vectorMs = performance.now() - vectorStartTime;

    const keywordStartTime = performance.now();
    const keywordResults = await this.keywordSearch(query, maxResults * 4);
    const keywordMs = performance.now() - keywordStartTime;

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && (this.config.scope === "global" || this.currentBranch !== "default")) {
      const ids = (await Promise.all(
        this.getBranchCatalogKeys().map((branchKey) => database.getBranchChunkIds(branchKey))
      )).flat();
      branchChunkIds = new Set(ids);
    }

    const prefilterStartTime = performance.now();
    const shouldPrefilterByBranch = branchChunkIds !== null && (this.config.scope === "global" || branchChunkIds.size > 0);
    const allowBranchPrefilterFallback = this.config.scope !== "global";
    const prefilteredSemantic = shouldPrefilterByBranch && branchChunkIds
      ? semanticResults.filter((r) => branchChunkIds.has(r.id))
      : semanticResults;
    const prefilteredKeyword = shouldPrefilterByBranch && branchChunkIds
      ? keywordResults.filter((r) => branchChunkIds.has(r.id))
      : keywordResults;

    const semanticCandidates = (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0)
      ? semanticResults
      : prefilteredSemantic;
    const keywordCandidates = (allowBranchPrefilterFallback && shouldPrefilterByBranch && keywordResults.length > 0 && prefilteredKeyword.length === 0)
      ? keywordResults
      : prefilteredKeyword;
    const prefilterMs = performance.now() - prefilterStartTime;

    if (this.config.scope !== "global" && branchChunkIds && branchChunkIds.size === 0) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    if (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no semantic overlap, using unfiltered semantic candidates", {
        branch: this.currentBranch,
      });
    }

    if (allowBranchPrefilterFallback && shouldPrefilterByBranch && keywordResults.length > 0 && prefilteredKeyword.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no keyword overlap, using unfiltered keyword candidates", {
        branch: this.currentBranch,
      });
    }

    const fusionStartTime = performance.now();
    const combined = rankHybridResults(query, semanticCandidates, keywordCandidates, {
      fusionStrategy,
      rrfK,
      rerankTopN,
      limit: maxResults,
      hybridWeight,
      prioritizeSourcePaths: sourceIntent,
    });
    const rerankedCombined = await this.rerankCandidatesWithApi(query, combined, {
      definitionIntent: options?.definitionIntent === true,
      hasIdentifierHints: identifierHints.length > 0,
    });
    const fusionMs = performance.now() - fusionStartTime;

    const rescued = await promoteIdentifierMatches(
      query,
      rerankedCombined,
      semanticCandidates,
      keywordCandidates,
      database,
      branchChunkIds,
      sourceIntent
    );

    const union = unionCandidates(semanticCandidates, keywordCandidates);

    const deterministicIdentifierLane = buildDeterministicIdentifierPass(
      query,
      union,
      maxResults,
      sourceIntent
    );

    const identifierLane = buildIdentifierDefinitionLane(
      query,
      union,
      maxResults,
      sourceIntent
    );

    const symbolLane = await buildSymbolDefinitionLane(
      query,
      database,
      branchChunkIds,
      maxResults,
      union,
      sourceIntent
    );

    const prePrimaryLane = mergeTieredResults(deterministicIdentifierLane, identifierLane, maxResults * 4);
    const primaryLane = mergeTieredResults(prePrimaryLane, symbolLane, maxResults * 4);
    const tiered = mergeTieredResults(primaryLane, rescued, maxResults * 4);
    const hasCodeHints = extractCodeTermHints(query).length > 0 || identifierHints.length > 0;

    const baseFiltered = tiered.filter((r) => {
      if (r.score < this.config.search.minScore) return false;

      if (options?.fileType) {
        const ext = r.metadata.filePath.split(".").pop()?.toLowerCase();
        if (ext !== options.fileType.toLowerCase().replace(/^\./, "")) return false;
      }

      if (options?.directory) {
        const normalizedDir = options.directory.replace(/^\/|\/$/g, "");
        if (!r.metadata.filePath.includes(`/${normalizedDir}/`) &&
          !r.metadata.filePath.includes(`${normalizedDir}/`)) return false;
      }

      if (options?.chunkType) {
        if (r.metadata.chunkType !== options.chunkType) return false;
      }

      return true;
    });

    const implementationOnly = baseFiltered.filter((r) =>
      isLikelyImplementationPath(r.metadata.filePath) &&
      isImplementationChunkType(r.metadata.chunkType)
    );

    const filtered = (sourceIntent && hasCodeHints && implementationOnly.length > 0
      ? implementationOnly
      : baseFiltered
    ).slice(0, maxResults);

    const finalResults = filtered;

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs,
      fusionMs,
    });
    this.logger.search("info", "Search complete", {
      query,
      results: finalResults.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      keywordMs: Math.round(keywordMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
      fusionMs: Math.round(fusionMs * 100) / 100,
    });

    const metadataOnly = options?.metadataOnly ?? false;

    return Promise.all(
      finalResults.map(async (r) => {
        let content = "";
        let contextStartLine = r.metadata.startLine;
        let contextEndLine = r.metadata.endLine;

        if (!metadataOnly && this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            const contextLines = options?.contextLines ?? this.config.search.contextLines;

            contextStartLine = Math.max(1, r.metadata.startLine - contextLines);
            contextEndLine = Math.min(lines.length, r.metadata.endLine + contextLines);

            content = lines
              .slice(contextStartLine - 1, contextEndLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: contextStartLine,
          endLine: contextEndLine,
          content,
          score: r.score,
          chunkType: r.metadata.chunkType,
          name: r.metadata.name,
        };
      })
    );
  }

  private async keywordSearch(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const { store, invertedIndex, database } = await this.ensureInitialized();
    // pgvector: use SQL BM25 (no in-memory index loaded); SQLite: use Rust struct
    const scores = await database.searchBm25(query, 100) ?? invertedIndex.search(query);

    if (scores.size === 0) {
      return [];
    }

    // Only fetch metadata for chunks returned by BM25 (O(n) where n = result count)
    // instead of getAllMetadata() which fetches ALL chunks in the index
    const chunkIds = Array.from(scores.keys());
    const metadataMap = await store.getMetadataBatch(chunkIds);

    const results: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];
    for (const [chunkId, score] of scores) {
      const metadata = metadataMap.get(chunkId);
      if (metadata && score > 0) {
        results.push({ id: chunkId, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getStatus(): Promise<StatusResult> {
    const { store, configuredProviderInfo, database } = await this.ensureInitialized();
    const failedBatchesCount = this.getFailedBatchesCount();
    const indexingInProgress = this.currentProgress !== undefined && this.currentProgress.phase !== "complete";

    // If not actively indexing in this process, check for a persisted progress snapshot
    // from another invocation (e.g., a watcher-triggered reindex running in parallel).
    let persistedProgress: IndexProgress | undefined;
    if (!indexingInProgress) {
      const snapshotJson = await database.getMetadata(PROGRESS_SNAPSHOT_KEY);
      if (snapshotJson) {
        try {
          const snapshot = JSON.parse(snapshotJson) as IndexProgress & { persistedAt?: number };
          const ageMs = Date.now() - (snapshot.persistedAt ?? 0);
          // Only surface if it's recent (< 30 min) and not already at "complete"
          if (ageMs < 30 * 60 * 1000 && snapshot.phase !== "complete") {
            persistedProgress = snapshot;
          }
        } catch { /* ignore malformed snapshot */ }
      }
    }

    return {
      indexed: await store.count() > 0,
      vectorCount: await store.count(),
      provider: configuredProviderInfo.provider,
      model: configuredProviderInfo.modelInfo.model,
      indexPath: this.indexPath,
      currentBranch: this.currentBranch,
      baseBranch: this.baseBranch,
      compatibility: this.indexCompatibility,
      failedBatchesCount,
      failedBatchesPath: failedBatchesCount > 0 ? this.failedBatchesPath : undefined,
      warning: await database.getMetadata(STARTUP_WARNING_METADATA_KEY) ?? undefined,
      indexingInProgress: indexingInProgress || persistedProgress !== undefined,
      progress: this.currentProgress ?? persistedProgress,
    };
  }

  async close(): Promise<void> {
    await this.database?.close();
    this.database = null;
    this.store = null;
    this.invertedIndex = null;
    this.provider = null;
    this.reranker = null;
    this.currentProgress = undefined;
    this.lastProgressSnapshot = "";
    this.embeddingPhaseStartTime = 0;
    this.embeddingChunksAtStart = 0;
    this.lastProgressPersistAt = 0;
  }

  async clearIndex(): Promise<void> {
    const { store, invertedIndex, database } = await this.ensureInitialized();

    if (this.config.scope === "global") {
      await store.load();
      const roots = this.getScopedRoots();
      const compatibility = await this.checkCompatibility();
      const allMetadata = await store.getAllMetadata();
      const hasForeignData =
        allMetadata.some(({ metadata }) => !this.isFileInCurrentScope(metadata.filePath, roots)) ||
        await this.hasForeignScopedFileHashData(roots) ||
        await this.hasForeignScopedBranchData() ||
        this.hasForeignScopedFailedBatches(roots);

      if (!compatibility.compatible && hasForeignData) {
        if (compatibility.code === IncompatibilityCode.EMBEDDING_STRATEGY_MISMATCH) {
          await this.clearSharedIndexProjectData(store, invertedIndex, database, roots);
          await this.clearScopedFileHashCache(roots);
          this.clearScopedFailedBatches(roots);
          await database.setMetadata(this.getProjectForceReembedMetadataKey(), "true");
          await database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey());
          this.indexCompatibility = { compatible: true };
          return;
        }

        throw new Error(
          `Global index compatibility reset is unsafe because the shared index contains files from other projects. ` +
          `The current global index cannot be force-rebuilt for ${this.projectRoot} without deleting other repositories' indexed data. ` +
          `Use scope="project" for isolated rebuilds, or manually delete the shared global index if you intend to rebuild all projects.`
        );
      }

      if (!hasForeignData) {
        await store.clear();
        await store.save();
        invertedIndex.clear();
        await this.database!.saveInvertedIndex(invertedIndex.serialize());

        await this.database!.replaceAllFileHashes(new Map(), this.computeSourceId(this.projectRoot));

        await database.clearAllIndexedData();
        this.saveFailedBatches([]);

        await database.deleteMetadata("index.version");
        await database.deleteMetadata("index.embeddingProvider");
        await database.deleteMetadata("index.embeddingModel");
        await database.deleteMetadata("index.embeddingDimensions");
        await database.deleteMetadata("index.embeddingStrategyVersion");
        await database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey());
        await database.deleteMetadata(this.getProjectForceReembedMetadataKey());
        await database.deleteMetadata(this.getLegacyMigrationMetadataKey());
        await database.deleteMetadata("index.createdAt");
        await database.deleteMetadata("index.updatedAt");

        this.indexCompatibility = await this.validateIndexCompatibility(this.configuredProviderInfo!);
        return;
      }

      await this.clearSharedIndexProjectData(store, invertedIndex, database, roots);
      await this.clearScopedFileHashCache(roots);
      this.clearScopedFailedBatches(roots);
      this.indexCompatibility = compatibility;
      return;
    }

    const localProjectIndexPath = path.join(this.projectRoot, ".opencode", "index");
    if (path.resolve(this.indexPath) !== path.resolve(localProjectIndexPath)) {
      throw new Error(
        "Project-scoped force rebuild is unsafe while using an inherited worktree index. " +
        "Create a local project config boundary before clearing the index."
      );
    }

    await store.clear();
    await store.save();
    invertedIndex.clear();
    await this.database!.saveInvertedIndex(invertedIndex.serialize());

    // Clear file hash cache so all files are re-parsed
    await this.database!.replaceAllFileHashes(new Map(), this.computeSourceId(this.projectRoot));

    // Clear persisted index data across all branches so force rebuilds
    // cannot reuse stale chunks, symbols, or embeddings from a prior provider.
    await database.clearAllIndexedData();
    this.saveFailedBatches([]);

    // Clear index metadata so compatibility is re-evaluated from scratch
    await database.deleteMetadata("index.version");
    await database.deleteMetadata("index.embeddingProvider");
    await database.deleteMetadata("index.embeddingModel");
    await database.deleteMetadata("index.embeddingDimensions");
    await database.deleteMetadata("index.embeddingStrategyVersion");
    await database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey());
    await database.deleteMetadata(this.getProjectForceReembedMetadataKey());
    await database.deleteMetadata(this.getLegacyMigrationMetadataKey());
    await database.deleteMetadata("index.createdAt");
    await database.deleteMetadata("index.updatedAt");

    // Re-validate compatibility (no stored metadata = compatible)
    this.indexCompatibility = await this.validateIndexCompatibility(this.configuredProviderInfo!);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const { store, invertedIndex, database } = await this.ensureInitialized();

    this.logger.gc("info", "Starting health check");

    const allMetadata = await store.getAllMetadata();
    const filePathsToChunkKeys = new Map<string, string[]>();

    for (const { key, metadata } of allMetadata) {
      const existing = filePathsToChunkKeys.get(metadata.filePath) || [];
      existing.push(key);
      filePathsToChunkKeys.set(metadata.filePath, existing);
    }

    const removedFilePaths: string[] = [];
    let removedCount = 0;

    for (const [filePath, chunkKeys] of filePathsToChunkKeys) {
      if (!existsSync(filePath)) {
        for (const key of chunkKeys) {
          await store.remove(key);
          invertedIndex.removeChunk(key);
          removedCount++;
        }
        await database.deleteChunksByFile(filePath);
        await database.deleteCallEdgesByFile(filePath);
        await database.deleteSymbolsByFile(filePath);
        removedFilePaths.push(filePath);
      }
    }

    if (removedCount > 0) {
      await store.save();
      await this.database!.saveInvertedIndex(invertedIndex.serialize());
    }

    let gcOrphanEmbeddings: number;
    let gcOrphanChunks: number;
    let gcOrphanSymbols: number;
    let gcOrphanCallEdges: number;

    try {
      gcOrphanEmbeddings = await database.gcOrphanEmbeddings();
      gcOrphanChunks = await database.gcOrphanChunks();
      gcOrphanSymbols = await database.gcOrphanSymbols();
      gcOrphanCallEdges = await database.gcOrphanCallEdges();
    } catch (error) {
      if (!(await this.tryResetCorruptedIndex("running index health check", error))) {
        throw error;
      }

      await this.ensureInitialized();

      return {
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
        resetCorruptedIndex: true,
        warning: this.getCorruptedIndexWarning(path.join(this.indexPath, "codebase.db")),
      };
    }

    this.logger.recordGc(removedCount, gcOrphanChunks, gcOrphanEmbeddings);
    this.logger.gc("info", "Health check complete", {
      removedStale: removedCount,
      orphanEmbeddings: gcOrphanEmbeddings,
      orphanChunks: gcOrphanChunks,
      removedFiles: removedFilePaths.length,
    });

    return { removed: removedCount, filePaths: removedFilePaths, gcOrphanEmbeddings, gcOrphanChunks, gcOrphanSymbols, gcOrphanCallEdges };
  }

  async retryFailedBatches(): Promise<{ succeeded: number; failed: number; remaining: number }> {
    const { store, provider, invertedIndex, database, configuredProviderInfo } = await this.ensureInitialized();
    const maxChunkTokens = getSafeEmbeddingChunkTokenLimit(configuredProviderInfo);
    const providerRateLimits = this.getProviderRateLimits(configuredProviderInfo.provider);

    const roots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const { scoped: scopedFailedBatches, retained: retainedFailedBatches } = roots
      ? this.partitionFailedBatches(roots, maxChunkTokens)
      : { scoped: this.loadFailedBatches(maxChunkTokens), retained: [] as FailedBatch[] };
    const failedBatches = scopedFailedBatches;
    if (failedBatches.length === 0) {
      return { succeeded: 0, failed: 0, remaining: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    const stillFailing: FailedBatch[] = [];

    for (const batch of failedBatches) {
      const batchChunksById = new Map(batch.chunks.map((chunk) => [chunk.id, chunk]));
      const embeddingPartsByChunk = new Map<string, Array<{ vector: number[]; tokenCount: number } | undefined>>();
      const completedChunkIds = new Set<string>();
      const failedChunkIds = new Set<string>();
      const failedChunksForBatch = new Map<string, FailedBatch>();
      const pooledResults: Array<{ chunk: PendingChunk; vector: number[] }> = [];
      try {
        const requestBatches = createPendingEmbeddingRequestBatches(
          batch.chunks,
          getDynamicBatchOptions(configuredProviderInfo)
        );

        for (const requestBatch of requestBatches) {
          try {
            const result = await pRetry(
              async () => {
                const texts = requestBatch.map((request) => request.text);
                return provider.embedBatch(texts);
              },
              {
                retries: this.config.indexing.retries,
                minTimeout: Math.max(this.config.indexing.retryDelayMs, providerRateLimits.minRetryMs),
                maxTimeout: providerRateLimits.maxRetryMs,
                factor: 2,
                shouldRetry: (error) => !((error as { error?: Error }).error instanceof CustomProviderNonRetryableError),
              }
            );

            const touchedChunkIds = new Set<string>();
            requestBatch.forEach((request, idx) => {
              if (failedChunkIds.has(request.chunk.id) || completedChunkIds.has(request.chunk.id)) {
                return;
              }

              const vector = result.embeddings[idx];
              if (!vector) {
                throw new Error(`Embedding API returned too few vectors for chunk ${request.chunk.id}`);
              }

              const parts = embeddingPartsByChunk.get(request.chunk.id) ?? [];
              parts[request.partIndex] = {
                vector,
                tokenCount: request.tokenCount,
              };
              embeddingPartsByChunk.set(request.chunk.id, parts);
              touchedChunkIds.add(request.chunk.id);
            });

            for (const chunkId of touchedChunkIds) {
              if (failedChunkIds.has(chunkId) || completedChunkIds.has(chunkId)) {
                continue;
              }

              const chunk = batchChunksById.get(chunkId);
              if (!chunk) {
                continue;
              }

              const parts = embeddingPartsByChunk.get(chunk.id) ?? [];
              if (!hasAllEmbeddingParts(parts, chunk.texts.length)) {
                continue;
              }

              const orderedParts = parts as Array<{ vector: number[]; tokenCount: number }>;
              pooledResults.push({
                chunk,
                vector: poolEmbeddingVectors(
                  orderedParts.map((part) => part.vector),
                  orderedParts.map((part) => part.tokenCount)
                ),
              });
            }

            this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
          } catch (error) {
            const failureMessage = String(error);
            const failureTimestamp = new Date().toISOString();
            const failedChunks = getUniquePendingChunksFromRequests(requestBatch)
              .filter((chunk) => !completedChunkIds.has(chunk.id) && !failedChunkIds.has(chunk.id));

            for (const chunk of failedChunks) {
              failedChunkIds.add(chunk.id);
              embeddingPartsByChunk.delete(chunk.id);
              failedChunksForBatch.set(chunk.id, {
                chunks: [chunk],
                attemptCount: batch.attemptCount + 1,
                lastAttempt: failureTimestamp,
                error: failureMessage,
              });
            }

            failed += failedChunks.length;
            this.logger.recordEmbeddingError();
          }
        }

        const successfulResults = pooledResults.filter(({ chunk }) => !failedChunkIds.has(chunk.id));

        const items = successfulResults.map(({ chunk, vector }) => ({
          id: chunk.id,
          vector,
          metadata: chunk.metadata,
        }));

        if (items.length > 0) {
          await store.addBatch(items);
        }

        if (successfulResults.length > 0) {
          try {
            await database.upsertEmbeddingsBatch(
              successfulResults.map(({ chunk, vector }) => ({
                contentHash: chunk.contentHash,
                embedding: float32ArrayToBuffer(vector),
                chunkText: chunk.storageText,
                model: configuredProviderInfo.modelInfo.model,
              }))
            );
          } catch (dbError) {
            // Rollback vectors added to store if DB write fails
            for (const { chunk } of successfulResults) {
              await store.remove(chunk.id);
            }
            throw dbError;
          }
        }

        for (const { chunk } of successfulResults) {
          invertedIndex.removeChunk(chunk.id);
          invertedIndex.addChunk(chunk.id, chunk.content);
          completedChunkIds.add(chunk.id);
          embeddingPartsByChunk.delete(chunk.id);
        }

        await database.addChunksToBranchBatch(
          this.getBranchCatalogKey(),
          successfulResults.map(({ chunk }) => chunk.id)
        );

        this.logger.recordChunksEmbedded(successfulResults.length);

        succeeded += successfulResults.length;
        stillFailing.push(...failedChunksForBatch.values());
      } catch (error) {
        const failureMessage = getErrorMessage(error);
        const failureTimestamp = new Date().toISOString();
        const unaccountedChunks = batch.chunks.filter(
          (chunk) => !failedChunksForBatch.has(chunk.id) && !completedChunkIds.has(chunk.id)
        );

        for (const chunk of unaccountedChunks) {
          failedChunksForBatch.set(chunk.id, {
            chunks: [chunk],
            attemptCount: batch.attemptCount + 1,
            lastAttempt: failureTimestamp,
            error: failureMessage,
          });
        }

        failed += unaccountedChunks.length;
        this.logger.recordEmbeddingError();
        stillFailing.push(...coalesceFailedBatches(Array.from(failedChunksForBatch.values())));
      }
    }

    const persistedStillFailing = coalesceFailedBatches(stillFailing);

    if (roots) {
      this.saveFailedBatches([...retainedFailedBatches, ...persistedStillFailing]);
    } else {
      this.saveFailedBatches(persistedStillFailing);
    }

    if (succeeded > 0) {
      await store.save();
      await this.database!.saveInvertedIndex(invertedIndex.serialize());
    }

    if (roots && succeeded > 0 && persistedStillFailing.length === 0 && await this.hasProjectForceReembedPending()) {
        await database.deleteMetadata(this.getProjectForceReembedMetadataKey());
        await this.saveIndexMetadata(configuredProviderInfo);
      this.indexCompatibility = { compatible: true };
    }

    return { succeeded, failed, remaining: persistedStillFailing.length };
  }

  getFailedBatchesCount(): number {
    if (this.config.scope === "global") {
      return this.partitionFailedBatches(this.getScopedRoots()).scoped.length;
    }
    return this.loadFailedBatches().length;
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  getBaseBranch(): string {
    return this.baseBranch;
  }

  refreshBranchInfo(): void {
    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
    }
  }

  async getDatabaseStats(): Promise<{ embeddingCount: number; chunkCount: number; branchChunkCount: number; branchCount: number } | null> {
    const { database } = await this.ensureInitialized();
    return await database.getStats();
  }

  getLogger(): Logger {
    return this.logger;
  }

  async findSimilar(
    code: string,
    limit: number = this.config.search.maxResults,
    options?: {
      fileType?: string;
      directory?: string;
      chunkType?: string;
      excludeFile?: string;
      filterByBranch?: boolean;
    }
  ): Promise<SearchResult[]> {
    const { store, provider, database } = await this.ensureInitialized();

    const compatibility = await this.checkCompatibility();
    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if ((await store.count()) === 0) {
      this.logger.search("debug", "Find similar on empty index");
      return [];
    }

    const filterByBranch = options?.filterByBranch ?? true;

    this.logger.search("debug", "Starting find similar", {
      codeLength: code.length,
      limit,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const { embedding, tokensUsed } = await provider.embedDocument(code);
    const embeddingMs = performance.now() - embeddingStartTime;
    this.logger.recordEmbeddingApiCall(tokensUsed);

    const vectorStartTime = performance.now();
    const semanticResults = await store.search(embedding, limit * 2);
    const vectorMs = performance.now() - vectorStartTime;

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && (this.config.scope === "global" || this.currentBranch !== "default")) {
      const ids = (await Promise.all(
        this.getBranchCatalogKeys().map((branchKey) => database.getBranchChunkIds(branchKey))
      )).flat();
      branchChunkIds = new Set(ids);
    }

    const prefilterStartTime = performance.now();
    const shouldPrefilterByBranch = branchChunkIds !== null && (this.config.scope === "global" || branchChunkIds.size > 0);
    const allowBranchPrefilterFallback = this.config.scope !== "global";
    const prefilteredSemantic = shouldPrefilterByBranch && branchChunkIds
      ? semanticResults.filter((r) => branchChunkIds.has(r.id))
      : semanticResults;
    const semanticCandidates = (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0)
      ? semanticResults
      : prefilteredSemantic;
    const prefilterMs = performance.now() - prefilterStartTime;

    if (this.config.scope !== "global" && branchChunkIds && branchChunkIds.size === 0) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    if (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no semantic overlap, using unfiltered semantic candidates", {
        branch: this.currentBranch,
      });
    }

    const rerankTopN = this.config.search.rerankTopN;

    const ranked = rankSemanticOnlyResults(code, semanticCandidates, {
      rerankTopN,
      limit,
      prioritizeSourcePaths: false,
    });

    const filtered = ranked.filter((r) => {
      if (r.score < this.config.search.minScore) return false;

      if (options?.excludeFile) {
        if (r.metadata.filePath === options.excludeFile) return false;
      }

      if (options?.fileType) {
        const ext = r.metadata.filePath.split(".").pop()?.toLowerCase();
        if (ext !== options.fileType.toLowerCase().replace(/^\./, "")) return false;
      }

      if (options?.directory) {
        const normalizedDir = options.directory.replace(/^\/|\/$/g, "");
        if (!r.metadata.filePath.includes(`/${normalizedDir}/`) &&
          !r.metadata.filePath.includes(`${normalizedDir}/`)) return false;
      }

      if (options?.chunkType) {
        if (r.metadata.chunkType !== options.chunkType) return false;
      }

      return true;
    }).slice(0, limit);

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs: 0,
      fusionMs: 0,
    });
    this.logger.search("info", "Find similar complete", {
      codeLength: code.length,
      results: filtered.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
    });

    return Promise.all(
      filtered.map(async (r) => {
        let content = "";

        if (this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            content = lines
              .slice(r.metadata.startLine - 1, r.metadata.endLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: r.metadata.startLine,
          endLine: r.metadata.endLine,
          content,
          score: r.score,
          chunkType: r.metadata.chunkType,
          name: r.metadata.name,
        };
      })
    );
  }

  async getCallers(targetName: string): Promise<CallEdgeData[]> {
    const { database } = await this.ensureInitialized();
    const seen = new Set<string>();
    const results: CallEdgeData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      for (const edge of await database.getCallersWithContext(targetName, branchKey)) {
        if (!seen.has(edge.id)) {
          seen.add(edge.id);
          results.push(edge);
        }
      }
    }

    return results;
  }

  async getCallees(symbolId: string): Promise<CallEdgeData[]> {
    const { database } = await this.ensureInitialized();
    const seen = new Set<string>();
    const results: CallEdgeData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      for (const edge of await database.getCallees(symbolId, branchKey)) {
        if (!seen.has(edge.id)) {
          seen.add(edge.id);
          results.push(edge);
        }
      }
    }

    return results;
  }
}
