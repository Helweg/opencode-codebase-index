import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, promises as fsPromises } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import PQueue from "p-queue";
import pRetry from "p-retry";

import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import { detectEmbeddingProvider, ConfiguredProviderInfo, tryDetectProvider, createCustomProviderInfo } from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
  CustomProviderNonRetryableError,
} from "../embeddings/provider.js";
import { collectFiles, SkippedFile } from "../utils/files.js";
import { createCostEstimate, CostEstimate } from "../utils/cost.js";
import { Logger, initializeLogger } from "../utils/logger.js";
import {
  VectorStore,
  InvertedIndex,
  Database,
  parseFiles,
  createEmbeddingText,
  generateChunkId,
  generateChunkHash,
  ChunkMetadata,
  ChunkData,
  createDynamicBatches,
  hashFile,
  hashContent,
  extractCalls,
} from "../native/index.js";
import type { SymbolData, CallEdgeData } from "../native/index.js";
import { getBranchOrDefault, getBaseBranch, isGitRepo } from "../git/index.js";

const CALL_GRAPH_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "php"]);
const CALL_GRAPH_SYMBOL_CHUNK_TYPES = new Set([
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
}

export interface IndexProgress {
  phase: "scanning" | "parsing" | "embedding" | "storing" | "complete";
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  currentFile?: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

interface PendingChunk {
  id: string;
  text: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

interface FailedBatch {
  chunks: PendingChunk[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

type RankedCandidate = { id: string; score: number; metadata: ChunkMetadata };

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
  createdAt: string;
  updatedAt: string;
}

enum IncompatibilityCode {
  DIMENSION_MISMATCH = "DIMENSION_MISMATCH",
  MODEL_MISMATCH = "MODEL_MISMATCH",
}

interface IndexCompatibility {
  compatible: boolean;
  code?: IncompatibilityCode;
  reason?: string;
  storedMetadata?: IndexMetadata;
}

const INDEX_METADATA_VERSION = "1";
const RANKING_TOKEN_CACHE_LIMIT = 4096;

const rankingQueryTokenCache = new Map<string, Set<string>>();
const rankingNameTokenCache = new Map<string, Set<string>>();
const rankingPathTokenCache = new Map<string, Set<string>>();
const rankingTextTokenCache = new Map<string, Set<string>>();

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
  return TEST_PATH_SEGMENTS.some((segment) => filePath.includes(segment));
}

function isLikelyImplementationPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  if (IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS.some((segment) => lowered.includes(segment))) {
    return false;
  }

  const ext = lowered.split(".").pop() ?? "";
  if (["md", "mdx", "txt", "rst", "adoc", "snap", "json", "yaml", "yml", "lock"].includes(ext)) {
    return false;
  }

  return true;
}

function classifyQueryIntent(tokens: string[]): "source" | "doc_test" {
  const sourceIntentHits = tokens.filter((t) => SOURCE_INTENT_HINTS.has(t)).length;
  const docTestIntentHits = tokens.filter((t) => DOC_TEST_INTENT_HINTS.has(t)).length;
  return sourceIntentHits >= docTestIntentHits ? "source" : "doc_test";
}

function classifyQueryIntentRaw(query: string): "source" | "doc_test" {
  const lowerQuery = query.toLowerCase();
  const docTestRawHits = Array.from(DOC_TEST_INTENT_HINTS).filter((hint) =>
    new RegExp(`\\b${hint}\\b`).test(lowerQuery)
  ).length;
  const sourceRawHits = [
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
  ].filter((hint) => new RegExp(`\\b${hint}\\b`).test(lowerQuery)).length;

  if (docTestRawHits > sourceRawHits) {
    return "doc_test";
  }

  if (sourceRawHits > docTestRawHits) {
    return "source";
  }

  const hasWhereIsPattern = /\bwhere\s+is\b/.test(lowerQuery);
  const hasIdentifierHints = extractIdentifierHints(query).length > 0;
  if (hasWhereIsPattern && hasIdentifierHints && docTestRawHits === 0) {
    return "source";
  }

  const queryTokens = Array.from(tokenizeTextForRanking(query));
  return classifyQueryIntent(queryTokens);
}

function classifyDocIntent(tokens: string[]): "docs" | "test" | "mixed" | "none" {
  const docHits = tokens.filter((t) => DOC_INTENT_HINTS.has(t)).length;
  const testHits = tokens.filter((t) => ["test", "tests", "fixture", "fixtures", "benchmark"].includes(t)).length;

  if (docHits > 0 && testHits === 0) return "docs";
  if (testHits > 0 && docHits === 0) return "test";
  if (testHits > 0 || docHits > 0) return "mixed";
  return "none";
}

function isImplementationChunkType(chunkType: string): boolean {
  return [
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
  ].includes(chunkType);
}

function extractIdentifierHints(query: string): string[] {
  const identifiers = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return identifiers
    .filter((id) => id.length >= 3)
    .filter((id) => {
      const lower = id.toLowerCase();
      if (STOPWORDS.has(lower)) return false;
      return /[A-Z]/.test(id) || id.includes("_") || id.endsWith("Results") || id.endsWith("Result");
    })
    .map((id) => id.toLowerCase());
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

  const tail = candidates.slice(topN);
  return [...head.map((entry) => entry.candidate), ...tail];
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

function promoteIdentifierMatches(
  query: string,
  combined: RankedCandidate[],
  semanticCandidates: RankedCandidate[],
  keywordCandidates: RankedCandidate[],
  database?: Database,
  branchChunkIds?: Set<string> | null,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
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
      const symbols = database.getSymbolsByName(identifier);
      for (const symbol of symbols) {
        const chunks = database.getChunksByFile(symbol.filePath);
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

function buildSymbolDefinitionLane(
  query: string,
  database: Database,
  branchChunkIds: Set<string> | null,
  limit: number,
  fallbackCandidates: RankedCandidate[],
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
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
    chunk: ReturnType<Database["getChunksByName"]>[number],
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
      ...database.getSymbolsByName(identifier),
      ...database.getSymbolsByNameCi(identifier),
    ];

    const chunksByName = [
      ...database.getChunksByName(identifier),
      ...database.getChunksByNameCi(identifier),
    ];

    const normalizedIdentifier = identifier.replace(/_/g, "");

    const dedupSymbols = new Map<string, typeof symbols[number]>();
    for (const symbol of symbols) {
      dedupSymbols.set(symbol.id, symbol);
    }

    for (const symbol of dedupSymbols.values()) {
      const chunks = database.getChunksByFile(symbol.filePath);
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
      ...database.getChunksByName(primaryHint),
      ...database.getChunksByNameCi(primaryHint),
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
  private store: VectorStore | null = null;
  private invertedIndex: InvertedIndex | null = null;
  private database: Database | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private configuredProviderInfo: ConfiguredProviderInfo | null = null;
  private fileHashCache: Map<string, string> = new Map();
  private fileHashCachePath: string = "";
  private failedBatchesPath: string = "";
  private currentBranch: string = "default";
  private baseBranch: string = "main";
  private logger: Logger;
  private queryEmbeddingCache: Map<string, { embedding: number[]; timestamp: number }> = new Map();
  private readonly maxQueryCacheSize = 100;
  private readonly queryCacheTtlMs = 5 * 60 * 1000;
  private readonly querySimilarityThreshold = 0.85;
  private indexCompatibility: IndexCompatibility | null = null;
  private indexingLockPath: string = "";

  constructor(projectRoot: string, config: ParsedCodebaseIndexConfig) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
    this.fileHashCachePath = path.join(this.indexPath, "file-hashes.json");
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
    this.indexingLockPath = path.join(this.indexPath, "indexing.lock");
    this.logger = initializeLogger(config.debug);
  }

  private getIndexPath(): string {
    if (this.config.scope === "global") {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      return path.join(homeDir, ".opencode", "global-index");
    }
    return path.join(this.projectRoot, ".opencode", "index");
  }

  private loadFileHashCache(): void {
    try {
      if (existsSync(this.fileHashCachePath)) {
        const data = readFileSync(this.fileHashCachePath, "utf-8");
        const parsed = JSON.parse(data);
        this.fileHashCache = new Map(Object.entries(parsed));
      }
    } catch {
      this.fileHashCache = new Map();
    }
  }

  private saveFileHashCache(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.fileHashCache) {
      obj[k] = v;
    }
    this.atomicWriteSync(this.fileHashCachePath, JSON.stringify(obj));
  }

  private atomicWriteSync(targetPath: string, data: string): void {
    const tempPath = `${targetPath}.tmp`;
    writeFileSync(tempPath, data);
    renameSync(tempPath, targetPath);
  }

  private checkForInterruptedIndexing(): boolean {
    return existsSync(this.indexingLockPath);
  }

  private acquireIndexingLock(): void {
    const lockData = {
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(this.indexingLockPath, JSON.stringify(lockData));
  }

  private releaseIndexingLock(): void {
    if (existsSync(this.indexingLockPath)) {
      unlinkSync(this.indexingLockPath);
    }
  }

  private async recoverFromInterruptedIndexing(): Promise<void> {
    this.logger.warn("Detected interrupted indexing session, recovering...");

    if (existsSync(this.fileHashCachePath)) {
      unlinkSync(this.fileHashCachePath);
    }

    await this.healthCheck();
    this.releaseIndexingLock();

    this.logger.info("Recovery complete, next index will re-process all files");
  }

  private loadFailedBatches(): FailedBatch[] {
    try {
      if (existsSync(this.failedBatchesPath)) {
        const data = readFileSync(this.failedBatchesPath, "utf-8");
        return JSON.parse(data) as FailedBatch[];
      }
    } catch {
      return [];
    }
    return [];
  }

  private saveFailedBatches(batches: FailedBatch[]): void {
    if (batches.length === 0) {
      if (existsSync(this.failedBatchesPath)) {
        fsPromises.unlink(this.failedBatchesPath).catch(() => { });
      }
      return;
    }
    writeFileSync(this.failedBatchesPath, JSON.stringify(batches, null, 2));
  }

  private addFailedBatch(batch: PendingChunk[], error: string): void {
    const existing = this.loadFailedBatches();
    existing.push({
      chunks: batch,
      error,
      attemptCount: 1,
      lastAttempt: new Date().toISOString(),
    });
    this.saveFailedBatches(existing);
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

  async initialize(): Promise<void> {
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
    });

    this.provider = createEmbeddingProvider(this.configuredProviderInfo);

    await fsPromises.mkdir(this.indexPath, { recursive: true });

    // NOTE: Interrupted indexing recovery is deferred until after store,
    // invertedIndex, and database are initialized (see below). Running it here
    // would cause infinite recursion: recovery → healthCheck → ensureInitialized
    // → initialize (store not yet set) → recovery → ...

    const dimensions = this.configuredProviderInfo.modelInfo.dimensions;
    const storePath = path.join(this.indexPath, "vectors");
    this.store = new VectorStore(storePath, dimensions);

    const indexFilePath = path.join(this.indexPath, "vectors.usearch");
    if (existsSync(indexFilePath)) {
      this.store.load();
    }

    const invertedIndexPath = path.join(this.indexPath, "inverted-index.json");
    this.invertedIndex = new InvertedIndex(invertedIndexPath);
    try {
      this.invertedIndex.load();
    } catch {
      if (existsSync(invertedIndexPath)) {
        await fsPromises.unlink(invertedIndexPath);
      }
      this.invertedIndex = new InvertedIndex(invertedIndexPath);
    }

    const dbPath = path.join(this.indexPath, "codebase.db");
    const dbIsNew = !existsSync(dbPath);
    this.database = new Database(dbPath);

    // Recover from interrupted indexing AFTER store, invertedIndex, and database
    // are all initialized. healthCheck() calls ensureInitialized() which checks
    // these fields — if they're not set, it re-enters initialize() causing infinite
    // recursion and 70GB+ memory usage.
    if (this.checkForInterruptedIndexing()) {
      await this.recoverFromInterruptedIndexing();
    }

    if (dbIsNew && this.store.count() > 0) {
      this.migrateFromLegacyIndex();
    }

    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    if (!this.indexCompatibility.compatible) {
      this.logger.warn("Index compatibility issue detected", {
        reason: this.indexCompatibility.reason,
        storedMetadata: this.indexCompatibility.storedMetadata,
        configuredProviderInfo: this.configuredProviderInfo,
      });
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

    // Auto-GC: Run garbage collection if enabled and interval has elapsed
    if (this.config.indexing.autoGc) {
      await this.maybeRunAutoGc();
    }
  }

  private async maybeRunAutoGc(): Promise<void> {
    if (!this.database) return;

    const lastGcTimestamp = this.database.getMetadata("lastGcTimestamp");
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
      await this.healthCheck();
      this.database.setMetadata("lastGcTimestamp", now.toString());
    }
  }

  private async maybeRunOrphanGc(): Promise<void> {
    if (!this.database) return;

    const stats = this.database.getStats();
    if (!stats) return;

    const orphanCount = stats.embeddingCount - stats.chunkCount;
    if (orphanCount > this.config.indexing.gcOrphanThreshold) {
      this.database.gcOrphanEmbeddings();
      this.database.gcOrphanChunks();
      this.database.setMetadata("lastGcTimestamp", Date.now().toString());
    }
  }

  private migrateFromLegacyIndex(): void {
    if (!this.store || !this.database) return;

    const allMetadata = this.store.getAllMetadata();
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
      this.database.upsertChunksBatch(chunkDataBatch);
    }
    this.database.addChunksToBranchBatch(this.currentBranch || "default", chunkIds);
  }

  private loadIndexMetadata(): IndexMetadata | null {
    if (!this.database) return null;

    const version = this.database.getMetadata("index.version");
    if (!version) return null;

    return {
      indexVersion: version,
      embeddingProvider: this.database.getMetadata("index.embeddingProvider") ?? "",
      embeddingModel: this.database.getMetadata("index.embeddingModel") ?? "",
      embeddingDimensions: parseInt(this.database.getMetadata("index.embeddingDimensions") ?? "0", 10),
      createdAt: this.database.getMetadata("index.createdAt") ?? "",
      updatedAt: this.database.getMetadata("index.updatedAt") ?? "",
    };
  }

  private saveIndexMetadata(provider: ConfiguredProviderInfo): void {
    if (!this.database) return;

    const now = new Date().toISOString();
    const existingCreatedAt = this.database.getMetadata("index.createdAt");

    this.database.setMetadata("index.version", INDEX_METADATA_VERSION);
    this.database.setMetadata("index.embeddingProvider", provider.provider);
    this.database.setMetadata("index.embeddingModel", provider.modelInfo.model);
    this.database.setMetadata("index.embeddingDimensions", provider.modelInfo.dimensions.toString());
    this.database.setMetadata("index.updatedAt", now);

    if (!existingCreatedAt) {
      this.database.setMetadata("index.createdAt", now);
    }
  }

  private validateIndexCompatibility(provider: ConfiguredProviderInfo): IndexCompatibility {
    const storedMetadata = this.loadIndexMetadata();

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

  checkCompatibility(): IndexCompatibility {
    if (!this.indexCompatibility) {
      if (!this.configuredProviderInfo) {
        throw new Error('No embedding provider info, you must initialize the indexer first.');
      }

      this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    }
    return this.indexCompatibility;
  }

  private async ensureInitialized(): Promise<{
    store: VectorStore;
    provider: EmbeddingProviderInterface;
    invertedIndex: InvertedIndex;
    configuredProviderInfo: ConfiguredProviderInfo;
    database: Database;
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

    const { files } = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    return createCostEstimate(files, configuredProviderInfo);
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    const { store, provider, invertedIndex, database, configuredProviderInfo } = await this.ensureInitialized();

    if (!this.indexCompatibility?.compatible) {
      throw new Error(
        `${this.indexCompatibility?.reason} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    this.acquireIndexingLock();
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

    onProgress?.({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    this.loadFileHashCache();

    const { files, skipped } = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    stats.totalFiles = files.length;
    stats.skippedFiles = skipped;

    this.logger.recordFilesScanned(files.length);
    this.logger.cache("debug", "Scanning files for changes", {
      totalFiles: files.length,
      skippedFiles: skipped.length,
    });

    const changedFiles: Array<{ path: string; content: string; hash: string }> = [];
    const unchangedFilePaths = new Set<string>();
    const currentFileHashes = new Map<string, string>();

    for (const f of files) {
      const currentHash = hashFile(f.path);
      currentFileHashes.set(f.path, currentHash);

      if (this.fileHashCache.get(f.path) === currentHash) {
        unchangedFilePaths.add(f.path);
        this.logger.recordCacheHit();
      } else {
        const content = await fsPromises.readFile(f.path, "utf-8");
        changedFiles.push({ path: f.path, content, hash: currentHash });
        this.logger.recordCacheMiss();
      }
    }

    this.logger.cache("info", "File hash cache results", {
      unchanged: unchangedFilePaths.size,
      changed: changedFiles.length,
    });

    onProgress?.({
      phase: "parsing",
      filesProcessed: 0,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const parseStartTime = performance.now();
    const parsedFiles = parseFiles(changedFiles);
    const parseMs = performance.now() - parseStartTime;

    this.logger.recordFilesParsed(parsedFiles.length);
    this.logger.recordParseDuration(parseMs);
    this.logger.debug("Parsed changed files", { parsedCount: parsedFiles.length, parseMs: parseMs.toFixed(2) });

    const existingChunks = new Map<string, string>();
    const existingChunksByFile = new Map<string, Set<string>>();
    for (const { key, metadata } of store.getAllMetadata()) {
      existingChunks.set(key, metadata.hash);
      const fileChunks = existingChunksByFile.get(metadata.filePath) || new Set();
      fileChunks.add(key);
      existingChunksByFile.set(metadata.filePath, fileChunks);
    }

    const currentChunkIds = new Set<string>();
    const currentFilePaths = new Set<string>();
    const pendingChunks: PendingChunk[] = [];

    for (const filePath of unchangedFilePaths) {
      currentFilePaths.add(filePath);
      const fileChunks = existingChunksByFile.get(filePath);
      if (fileChunks) {
        for (const chunkId of fileChunks) {
          currentChunkIds.add(chunkId);
        }
      }
    }

    const chunkDataBatch: ChunkData[] = [];

    for (const parsed of parsedFiles) {
      currentFilePaths.add(parsed.path);

      if (parsed.chunks.length === 0) {
        const relativePath = path.relative(this.projectRoot, parsed.path);
        stats.parseFailures.push(relativePath);
      }

      let fileChunkCount = 0;
      for (const chunk of parsed.chunks) {
        if (fileChunkCount >= this.config.indexing.maxChunksPerFile) {
          break;
        }

        if (this.config.indexing.semanticOnly && chunk.chunkType === "other") {
          continue;
        }

        const id = generateChunkId(parsed.path, chunk);
        const contentHash = generateChunkHash(chunk);
        currentChunkIds.add(id);

        chunkDataBatch.push({
          chunkId: id,
          contentHash,
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          nodeType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
        });

        if (existingChunks.get(id) === contentHash) {
          fileChunkCount++;
          continue;
        }

        const text = createEmbeddingText(chunk, parsed.path);
        const metadata: ChunkMetadata = {
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
          hash: contentHash,
        };

        pendingChunks.push({ id, text, content: chunk.content, contentHash, metadata });
        fileChunkCount++;
      }
    }

    if (chunkDataBatch.length > 0) {
      database.upsertChunksBatch(chunkDataBatch);
    }


    // ── Call Graph Extraction ────────────────────────────────────────
    // Extract symbols and call edges from changed files.
    const allSymbolIds = new Set<string>();
    const symbolsByFile = new Map<string, SymbolData[]>();

    // For changed files: delete old symbols/edges, extract new ones
    for (let i = 0; i < parsedFiles.length; i++) {
      const parsed = parsedFiles[i];
      const changedFile = changedFiles[i];

      // Clean up old call graph data for this file
      database.deleteCallEdgesByFile(parsed.path);
      database.deleteSymbolsByFile(parsed.path);

      // Build symbols from parsed chunks
      const fileSymbols: SymbolData[] = [];

      for (const chunk of parsed.chunks) {
        if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;

        const symbolId = `sym_${hashContent(parsed.path + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`;
        const symbol: SymbolData = {
          id: symbolId,
          filePath: parsed.path,
          name: chunk.name,
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: 0,
          endLine: chunk.endLine,
          endCol: 0,
          language: chunk.language,
        };
        fileSymbols.push(symbol);
        allSymbolIds.add(symbolId);
      }

      const symbolsByName = new Map<string, SymbolData[]>();
      for (const symbol of fileSymbols) {
        const existing = symbolsByName.get(symbol.name) ?? [];
        existing.push(symbol);
        symbolsByName.set(symbol.name, existing);
      }

      if (fileSymbols.length > 0) {
        database.upsertSymbolsBatch(fileSymbols);
        symbolsByFile.set(parsed.path, fileSymbols);
      }

      // Extract call sites from file content (only for supported languages)
      const fileLanguage = parsed.chunks[0]?.language;
      if (!fileLanguage || !CALL_GRAPH_LANGUAGES.has(fileLanguage)) continue;

      const callSites = extractCalls(changedFile.content, fileLanguage);
      if (callSites.length === 0) continue;

      // Map each call site to its enclosing symbol
      const edges: CallEdgeData[] = [];
      for (const site of callSites) {
        // Find the enclosing symbol (function/method that contains this call)
        const enclosingSymbol = fileSymbols.find(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine
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
        database.upsertCallEdgesBatch(edges);

        // Resolve same-file calls
        for (const edge of edges) {
          const candidates = symbolsByName.get(edge.targetName);
          if (candidates && candidates.length === 1) {
            database.resolveCallEdge(edge.id, candidates[0].id);
          }
        }
      }
    }

    // Collect symbol IDs from unchanged files for branch association
    for (const filePath of unchangedFilePaths) {
      const existingSymbols = database.getSymbolsByFile(filePath);
      for (const sym of existingSymbols) {
        allSymbolIds.add(sym.id);
      }
    }

    let removedCount = 0;
    for (const [chunkId] of existingChunks) {
      if (!currentChunkIds.has(chunkId)) {
        store.remove(chunkId);
        invertedIndex.removeChunk(chunkId);
        removedCount++;
      }
    }

    stats.totalChunks = pendingChunks.length;
    stats.existingChunks = currentChunkIds.size - pendingChunks.length;
    stats.removedChunks = removedCount;

    this.logger.recordChunksProcessed(currentChunkIds.size);
    this.logger.recordChunksRemoved(removedCount);
    this.logger.info("Chunk analysis complete", {
      pending: pendingChunks.length,
      existing: stats.existingChunks,
      removed: removedCount,
    });

    if (pendingChunks.length === 0 && removedCount === 0) {
      database.clearBranch(this.currentBranch);
      database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));
      database.clearBranchSymbols(this.currentBranch);
      database.addSymbolsToBranchBatch(this.currentBranch, Array.from(allSymbolIds));
      this.fileHashCache = currentFileHashes;
      this.saveFileHashCache();
      stats.durationMs = Date.now() - startTime;
      onProgress?.({
        phase: "complete",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      this.releaseIndexingLock();
      return stats;
    }

    if (pendingChunks.length === 0) {
      database.clearBranch(this.currentBranch);
      database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));
      database.clearBranchSymbols(this.currentBranch);
      database.addSymbolsToBranchBatch(this.currentBranch, Array.from(allSymbolIds));
      store.save();
      invertedIndex.save();
      this.fileHashCache = currentFileHashes;
      this.saveFileHashCache();
      stats.durationMs = Date.now() - startTime;
      onProgress?.({
        phase: "complete",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      this.releaseIndexingLock();
      return stats;
    }

    onProgress?.({
      phase: "embedding",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: pendingChunks.length,
    });

    const allContentHashes = pendingChunks.map((c) => c.contentHash);
    const missingHashes = new Set(database.getMissingEmbeddings(allContentHashes));

    const chunksNeedingEmbedding = pendingChunks.filter((c) => missingHashes.has(c.contentHash));
    const chunksWithExistingEmbedding = pendingChunks.filter((c) => !missingHashes.has(c.contentHash));

    this.logger.cache("info", "Embedding cache lookup", {
      needsEmbedding: chunksNeedingEmbedding.length,
      fromCache: chunksWithExistingEmbedding.length,
    });
    this.logger.recordChunksFromCache(chunksWithExistingEmbedding.length);

    for (const chunk of chunksWithExistingEmbedding) {
      const embeddingBuffer = database.getEmbedding(chunk.contentHash);
      if (embeddingBuffer) {
        const vector = bufferToFloat32Array(embeddingBuffer);
        store.add(chunk.id, Array.from(vector), chunk.metadata);
        invertedIndex.removeChunk(chunk.id);
        invertedIndex.addChunk(chunk.id, chunk.content);
        stats.indexedChunks++;
      }
    }

    const providerRateLimits = this.getProviderRateLimits(configuredProviderInfo.provider);
    const queue = new PQueue({
      concurrency: providerRateLimits.concurrency,
      interval: providerRateLimits.intervalMs,
      intervalCap: providerRateLimits.concurrency
    });
    const dynamicBatches = createDynamicBatches(chunksNeedingEmbedding);
    let rateLimitBackoffMs = 0;

    for (const batch of dynamicBatches) {
      queue.add(async () => {
        if (rateLimitBackoffMs > 0) {
          await new Promise(resolve => setTimeout(resolve, rateLimitBackoffMs));
        }

        try {
          const result = await pRetry(
            async () => {
              const texts = batch.map((c) => c.text);
              return provider.embedBatch(texts);
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

          const items = batch.map((chunk, idx) => ({
            id: chunk.id,
            vector: result.embeddings[idx],
            metadata: chunk.metadata,
          }));

          store.addBatch(items);

          const embeddingBatchItems = batch.map((chunk, i) => ({
            contentHash: chunk.contentHash,
            embedding: float32ArrayToBuffer(result.embeddings[i]),
            chunkText: chunk.text,
            model: configuredProviderInfo.modelInfo.model,
          }));
          database.upsertEmbeddingsBatch(embeddingBatchItems);

          for (const chunk of batch) {
            invertedIndex.removeChunk(chunk.id);
            invertedIndex.addChunk(chunk.id, chunk.content);
          }

          stats.indexedChunks += batch.length;
          stats.tokensUsed += result.totalTokensUsed;

          this.logger.recordChunksEmbedded(batch.length);
          this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
          this.logger.embedding("debug", `Embedded batch`, {
            batchSize: batch.length,
            tokens: result.totalTokensUsed,
          });

          onProgress?.({
            phase: "embedding",
            filesProcessed: files.length,
            totalFiles: files.length,
            chunksProcessed: stats.indexedChunks,
            totalChunks: pendingChunks.length,
          });
        } catch (error) {
          stats.failedChunks += batch.length;
          this.addFailedBatch(batch, getErrorMessage(error));
          this.logger.recordEmbeddingError();
          this.logger.embedding("error", `Failed to embed batch after retries`, {
            batchSize: batch.length,
            error: getErrorMessage(error),
          });
        }
      });
    }

    await queue.onIdle();

    onProgress?.({
      phase: "storing",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: pendingChunks.length,
    });

    database.clearBranch(this.currentBranch);
    database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));
    database.clearBranchSymbols(this.currentBranch);
    database.addSymbolsToBranchBatch(this.currentBranch, Array.from(allSymbolIds));

    store.save();
    invertedIndex.save();
    this.fileHashCache = currentFileHashes;
    this.saveFileHashCache();

    // Auto-GC after indexing: check if orphan count exceeds threshold
    if (this.config.indexing.autoGc && stats.removedChunks > 0) {
      await this.maybeRunOrphanGc();
    }

    stats.durationMs = Date.now() - startTime;

    this.saveIndexMetadata(configuredProviderInfo);
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

    onProgress?.({
      phase: "complete",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: pendingChunks.length,
    });

    this.releaseIndexingLock();
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

    const compatibility = this.checkCompatibility();
    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `A possible solution is to run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if (store.count() === 0) {
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
    const semanticResults = store.search(embedding, maxResults * 4);
    const vectorMs = performance.now() - vectorStartTime;

    const keywordStartTime = performance.now();
    const keywordResults = await this.keywordSearch(query, maxResults * 4);
    const keywordMs = performance.now() - keywordStartTime;

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && this.currentBranch !== "default") {
      branchChunkIds = new Set(database.getBranchChunkIds(this.currentBranch));
    }

    const prefilterStartTime = performance.now();
    const shouldPrefilterByBranch = branchChunkIds !== null && branchChunkIds.size > 0;
    const prefilteredSemantic = shouldPrefilterByBranch && branchChunkIds
      ? semanticResults.filter((r) => branchChunkIds.has(r.id))
      : semanticResults;
    const prefilteredKeyword = shouldPrefilterByBranch && branchChunkIds
      ? keywordResults.filter((r) => branchChunkIds.has(r.id))
      : keywordResults;

    const semanticCandidates = (shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0)
      ? semanticResults
      : prefilteredSemantic;
    const keywordCandidates = (shouldPrefilterByBranch && keywordResults.length > 0 && prefilteredKeyword.length === 0)
      ? keywordResults
      : prefilteredKeyword;
    const prefilterMs = performance.now() - prefilterStartTime;

    if (branchChunkIds && branchChunkIds.size === 0) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    if (shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no semantic overlap, using unfiltered semantic candidates", {
        branch: this.currentBranch,
      });
    }

    if (shouldPrefilterByBranch && keywordResults.length > 0 && prefilteredKeyword.length === 0) {
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
    const fusionMs = performance.now() - fusionStartTime;

    const rescued = promoteIdentifierMatches(
      query,
      combined,
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

    const symbolLane = buildSymbolDefinitionLane(
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
    const hasCodeHints = extractCodeTermHints(query).length > 0 || extractIdentifierHints(query).length > 0;

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

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs,
      fusionMs,
    });
    this.logger.search("info", "Search complete", {
      query,
      results: filtered.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      keywordMs: Math.round(keywordMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
      fusionMs: Math.round(fusionMs * 100) / 100,
    });

    const metadataOnly = options?.metadataOnly ?? false;

    return Promise.all(
      filtered.map(async (r) => {
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
    const { store, invertedIndex } = await this.ensureInitialized();
    const scores = invertedIndex.search(query);

    if (scores.size === 0) {
      return [];
    }

    // Only fetch metadata for chunks returned by BM25 (O(n) where n = result count)
    // instead of getAllMetadata() which fetches ALL chunks in the index
    const chunkIds = Array.from(scores.keys());
    const metadataMap = store.getMetadataBatch(chunkIds);

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
    const { store, configuredProviderInfo } = await this.ensureInitialized();

    return {
      indexed: store.count() > 0,
      vectorCount: store.count(),
      provider: configuredProviderInfo.provider,
      model: configuredProviderInfo.modelInfo.model,
      indexPath: this.indexPath,
      currentBranch: this.currentBranch,
      baseBranch: this.baseBranch,
      compatibility: this.indexCompatibility,
    };
  }

  async clearIndex(): Promise<void> {
    const { store, invertedIndex, database } = await this.ensureInitialized();

    store.clear();
    store.save();
    invertedIndex.clear();
    invertedIndex.save();

    // Clear file hash cache so all files are re-parsed
    this.fileHashCache.clear();
    this.saveFileHashCache();

    // Clear branch catalog
    database.clearBranch(this.currentBranch);
    database.clearBranchSymbols(this.currentBranch);

    // Clear index metadata so compatibility is re-evaluated from scratch
    database.deleteMetadata("index.version");
    database.deleteMetadata("index.embeddingProvider");
    database.deleteMetadata("index.embeddingModel");
    database.deleteMetadata("index.embeddingDimensions");
    database.deleteMetadata("index.createdAt");
    database.deleteMetadata("index.updatedAt");

    // Re-validate compatibility (no stored metadata = compatible)
    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo!);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const { store, invertedIndex, database } = await this.ensureInitialized();

    this.logger.gc("info", "Starting health check");

    const allMetadata = store.getAllMetadata();
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
          store.remove(key);
          invertedIndex.removeChunk(key);
          removedCount++;
        }
        database.deleteChunksByFile(filePath);
        database.deleteCallEdgesByFile(filePath);
        database.deleteSymbolsByFile(filePath);
        removedFilePaths.push(filePath);
      }
    }

    if (removedCount > 0) {
      store.save();
      invertedIndex.save();
    }

    const gcOrphanEmbeddings = database.gcOrphanEmbeddings();
    const gcOrphanChunks = database.gcOrphanChunks();
    const gcOrphanSymbols = database.gcOrphanSymbols();
    const gcOrphanCallEdges = database.gcOrphanCallEdges();

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
    const { store, provider, invertedIndex } = await this.ensureInitialized();

    const failedBatches = this.loadFailedBatches();
    if (failedBatches.length === 0) {
      return { succeeded: 0, failed: 0, remaining: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    const stillFailing: FailedBatch[] = [];

    for (const batch of failedBatches) {
      try {
        const result = await pRetry(
          async () => {
            const texts = batch.chunks.map((c) => c.text);
            return provider.embedBatch(texts);
          },
          {
            retries: this.config.indexing.retries,
            minTimeout: this.config.indexing.retryDelayMs,
          }
        );

        const items = batch.chunks.map((chunk, idx) => ({
          id: chunk.id,
          vector: result.embeddings[idx],
          metadata: chunk.metadata,
        }));

        store.addBatch(items);

        for (const chunk of batch.chunks) {
          invertedIndex.removeChunk(chunk.id);
          invertedIndex.addChunk(chunk.id, chunk.content);
        }

        this.logger.recordChunksEmbedded(batch.chunks.length);
        this.logger.recordEmbeddingApiCall(result.totalTokensUsed);

        succeeded += batch.chunks.length;
      } catch (error) {
        failed += batch.chunks.length;
        this.logger.recordEmbeddingError();
        stillFailing.push({
          ...batch,
          attemptCount: batch.attemptCount + 1,
          lastAttempt: new Date().toISOString(),
          error: String(error),
        });
      }
    }

    this.saveFailedBatches(stillFailing);

    if (succeeded > 0) {
      store.save();
      invertedIndex.save();
    }

    return { succeeded, failed, remaining: stillFailing.length };
  }

  getFailedBatchesCount(): number {
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
    return database.getStats();
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
    
    const compatibility = this.checkCompatibility();
    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if (store.count() === 0) {
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
    const semanticResults = store.search(embedding, limit * 2);
    const vectorMs = performance.now() - vectorStartTime;

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && this.currentBranch !== "default") {
      branchChunkIds = new Set(database.getBranchChunkIds(this.currentBranch));
    }

    const prefilterStartTime = performance.now();
    const shouldPrefilterByBranch = branchChunkIds !== null && branchChunkIds.size > 0;
    const prefilteredSemantic = shouldPrefilterByBranch && branchChunkIds
      ? semanticResults.filter((r) => branchChunkIds.has(r.id))
      : semanticResults;
    const semanticCandidates = (shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0)
      ? semanticResults
      : prefilteredSemantic;
    const prefilterMs = performance.now() - prefilterStartTime;

    if (branchChunkIds && branchChunkIds.size === 0) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    if (shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0) {
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
    return database.getCallersWithContext(targetName, this.currentBranch);
  }

  async getCallees(symbolId: string): Promise<CallEdgeData[]> {
    const { database } = await this.ensureInitialized();
    return database.getCallees(symbolId, this.currentBranch);
  }
}
