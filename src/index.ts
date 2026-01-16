import type { Plugin } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "fs";
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
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore config file read errors, use defaults
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

    async config(cfg) {
      cfg.command = cfg.command ?? {};

      cfg.command["search"] = {
        description: "Search codebase by meaning using semantic search",
        template: `Use the \`codebase_search\` tool to find code related to: $ARGUMENTS

If the index doesn't exist yet, run \`index_codebase\` first.

Return the most relevant results with file paths and line numbers.`,
      };

      cfg.command["find"] = {
        description: "Find code using hybrid approach (semantic + grep)",
        template: `Find code related to: $ARGUMENTS

Strategy:
1. First use \`codebase_search\` to find semantically related code
2. From the results, identify specific function/class names
3. Use grep to find all occurrences of those identifiers
4. Combine findings into a comprehensive answer

If the semantic index doesn't exist, run \`index_codebase\` first.`,
      };

      cfg.command["index"] = {
        description: "Index the codebase for semantic search",
        template: `Run the \`index_codebase\` tool to create or update the semantic search index.

Show progress and final statistics including:
- Number of files processed
- Number of chunks indexed
- Tokens used
- Duration`,
      };
    },
  };
};

export default plugin;
