import * as path from "path";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";

import { Database, VectorStore, InvertedIndex, ChunkData, ChunkType } from "../native/index.js";

export interface DeltaIndexes {
  vectorStore: VectorStore;
  invertedIndex: InvertedIndex;
}

export interface DeltaInfo {
  branch: string;
  baseBranch: string;
  addedChunks: string[];
  removedChunks: string[];
}

export async function buildDeltaIndexes(
  database: Database,
  indexPath: string,
  branch: string,
  baseBranch: string,
  dimensions: number
): Promise<DeltaInfo> {
  const delta = database.getBranchDelta(branch, baseBranch);
  
  const deltaPath = path.join(indexPath, `delta-${sanitizeBranchName(branch)}`);
  mkdirSync(deltaPath, { recursive: true });

  const vectorStorePath = path.join(deltaPath, "vectors");
  const vectorStore = new VectorStore(vectorStorePath, dimensions);
  
  const invertedIndexPath = path.join(deltaPath, "inverted-index.json");
  const invertedIndex = new InvertedIndex(invertedIndexPath);

  for (const chunkId of delta.added) {
    const chunk = database.getChunk(chunkId);
    if (!chunk) continue;

    const embedding = database.getEmbedding(chunk.contentHash);
    if (!embedding) continue;

    const vector = bufferToFloat32Array(embedding);
    vectorStore.add(chunkId, Array.from(vector), {
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkType: (chunk.nodeType || "other") as ChunkType,
      name: chunk.name,
      language: chunk.language,
      hash: chunk.contentHash,
    });

    const chunkContent = getChunkContent(chunk);
    if (chunkContent) {
      invertedIndex.addChunk(chunkId, chunkContent);
    }
  }

  vectorStore.save();
  invertedIndex.save();

  return {
    branch,
    baseBranch,
    addedChunks: delta.added,
    removedChunks: delta.removed,
  };
}

export function loadDeltaIndexes(
  indexPath: string,
  branch: string,
  dimensions: number
): DeltaIndexes | null {
  const deltaPath = path.join(indexPath, `delta-${sanitizeBranchName(branch)}`);
  
  const vectorStorePath = path.join(deltaPath, "vectors");
  const vectorIndexPath = path.join(deltaPath, "vectors.usearch");
  
  if (!existsSync(vectorIndexPath)) {
    return null;
  }

  const vectorStore = new VectorStore(vectorStorePath, dimensions);
  vectorStore.load();
  
  const invertedIndexPath = path.join(deltaPath, "inverted-index.json");
  const invertedIndex = new InvertedIndex(invertedIndexPath);
  invertedIndex.load();

  return { vectorStore, invertedIndex };
}

export function deleteDeltaIndexes(indexPath: string, branch: string): boolean {
  const deltaPath = path.join(indexPath, `delta-${sanitizeBranchName(branch)}`);
  
  if (!existsSync(deltaPath)) {
    return false;
  }

  try {
    rmSync(deltaPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function getChunkContent(chunk: ChunkData): string | null {
  try {
    const content = readFileSync(chunk.filePath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
  } catch {
    return null;
  }
}
