import type { Plugin } from "@opencode-ai/plugin";

import { parseConfig } from "./config/schema.js";
import { Indexer } from "./indexer/index.js";
import { FileWatcher, createWatcherWithIndexer } from "./watcher/index.js";
import {
  codebase_search,
  index_codebase,
  index_status,
  initializeTools,
} from "./tools/index.js";

let watcher: FileWatcher | null = null;

const plugin: Plugin = async ({ project, directory }) => {
  const projectRoot = directory;
  const projectConfig = project.config?.["codebaseIndex"] ?? {};
  const config = parseConfig(projectConfig);

  initializeTools(projectRoot, config);

  const indexer = new Indexer(projectRoot, config);

  if (config.indexing.watchFiles) {
    watcher = createWatcherWithIndexer(indexer, projectRoot, config);
  }

  return {
    tool: {
      codebase_search,
      index_codebase,
      index_status,
    },
  };
};

export default plugin;

export { Indexer } from "./indexer/index.js";
export { FileWatcher } from "./watcher/index.js";
export * from "./config/schema.js";
export * from "./native/index.js";
export * from "./embeddings/index.js";
export * from "./utils/index.js";
