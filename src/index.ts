import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { Indexer } from "./indexer/index.js";
import { createWatcherWithIndexer } from "./watcher/index.js";
import {
  codebase_search,
  index_codebase,
  index_status,
  index_health_check,
  initializeTools,
} from "./tools/index.js";

function loadPluginConfig(projectRoot: string): unknown {
  const configPath = path.join(projectRoot, ".opencode", "codebase-index.json");
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content);
    }
  } catch {
  }
  return {};
}

const plugin: Plugin = async ({ directory }) => {
  const projectRoot = directory;
  const rawConfig = loadPluginConfig(projectRoot);
  const config = parseConfig(rawConfig);

  initializeTools(projectRoot, config);

  const indexer = new Indexer(projectRoot, config);

  if (config.indexing.autoIndex) {
    indexer.initialize().then(() => {
      indexer.index().catch(() => {});
    }).catch(() => {});
  }

  if (config.indexing.watchFiles) {
    createWatcherWithIndexer(indexer, projectRoot, config);
  }

  return {
    tool: {
      codebase_search,
      index_codebase,
      index_status,
      index_health_check,
    },
  };
};

export default plugin;

export { Indexer } from "./indexer/index.js";
export { FileWatcher } from "./watcher/index.js";
export * from "./config/schema.js";
export {
  VectorStore,
  parseFile,
  parseFiles,
  hashContent,
  hashFile,
  createEmbeddingText,
  createDynamicBatches,
  generateChunkId,
  generateChunkHash,
  type FileInput,
  type CodeChunk,
  type ChunkType,
  type ParsedFile,
  type SearchResult,
  type ChunkMetadata,
} from "./native/index.js";
export * from "./embeddings/index.js";
export * from "./utils/index.js";
