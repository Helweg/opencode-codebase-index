import { EmbeddingModelInfo } from "../config/schema.js";
import { getProviderDisplayName, DetectedProvider } from "../embeddings/detector.js";

export interface CostEstimate {
  filesCount: number;
  totalSizeBytes: number;
  estimatedChunks: number;
  estimatedTokens: number;
  estimatedCost: number;
  provider: string;
  model: string;
  isFree: boolean;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateChunksFromFiles(
  files: Array<{ path: string; size: number }>
): number {
  let totalChunks = 0;

  for (const file of files) {
    const avgChunkSize = 400;
    const chunksPerFile = Math.max(1, Math.ceil(file.size / avgChunkSize));
    totalChunks += chunksPerFile;
  }

  return totalChunks;
}

export function estimateCost(
  estimatedTokens: number,
  modelInfo: EmbeddingModelInfo
): number {
  return (estimatedTokens / 1_000_000) * modelInfo.costPer1MTokens;
}

export function createCostEstimate(
  files: Array<{ path: string; size: number }>,
  provider: DetectedProvider
): CostEstimate {
  const filesCount = files.length;
  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const estimatedChunks = estimateChunksFromFiles(files);
  const avgTokensPerChunk = 150;
  const estimatedTokens = estimatedChunks * avgTokensPerChunk;
  const estimatedCost = estimateCost(estimatedTokens, provider.modelInfo);

  return {
    filesCount,
    totalSizeBytes,
    estimatedChunks,
    estimatedTokens,
    estimatedCost,
    provider: getProviderDisplayName(provider.provider),
    model: provider.modelInfo.model,
    isFree: provider.modelInfo.costPer1MTokens === 0,
  };
}

export function formatCostEstimate(estimate: CostEstimate): string {
  const sizeFormatted = formatBytes(estimate.totalSizeBytes);
  const costFormatted = estimate.isFree
    ? "Free"
    : `~$${estimate.estimatedCost.toFixed(4)}`;

  return `
┌─────────────────────────────────────────────────────────────────┐
│  📊 Indexing Estimate                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Files to index:     ${padRight(estimate.filesCount.toLocaleString() + " files", 40)}│
│  Total size:         ${padRight(sizeFormatted, 40)}│
│  Estimated chunks:   ${padRight("~" + estimate.estimatedChunks.toLocaleString() + " chunks", 40)}│
│  Estimated tokens:   ${padRight("~" + estimate.estimatedTokens.toLocaleString() + " tokens", 40)}│
│                                                                 │
│  Provider: ${padRight(estimate.provider, 52)}│
│  Model:    ${padRight(estimate.model, 52)}│
│  Cost:     ${padRight(costFormatted, 52)}│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function padRight(str: string, length: number): string {
  return str.padEnd(length);
}

export interface ConfirmationResult {
  confirmed: boolean;
  rememberChoice: boolean;
}

export function formatConfirmationPrompt(): string {
  return `
Proceed with indexing? [Y/n/always]

  Y      - Index now
  n      - Cancel
  always - Index now and don't ask again for this project
`;
}

export function parseConfirmationResponse(response: string): ConfirmationResult {
  const normalized = response.toLowerCase().trim();

  if (normalized === "" || normalized === "y" || normalized === "yes") {
    return { confirmed: true, rememberChoice: false };
  }

  if (normalized === "always" || normalized === "a") {
    return { confirmed: true, rememberChoice: true };
  }

  return { confirmed: false, rememberChoice: false };
}
