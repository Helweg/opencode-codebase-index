import type { Plugin } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { Indexer } from "./indexer/index.js";
import { createWatcherWithIndexer } from "./watcher/index.js";
import {
  codebase_search,
  codebase_peek,
  index_codebase,
  index_status,
  index_health_check,
  index_metrics,
  index_logs,
  find_similar,
  initializeTools,
} from "./tools/index.js";
import { loadCommandsFromDirectory } from "./commands/loader.js";

function getCommandsDir(): string {
  let currentDir = process.cwd();
  
  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }
  
  return path.join(currentDir, "..", "commands");
}

function loadJsonFile(filePath: string): unknown {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    }
  } catch { /* ignore */ }
  return null;
}

function loadPluginConfig(projectRoot: string): unknown {
  const projectConfig = loadJsonFile(path.join(projectRoot, ".opencode", "codebase-index.json"));
  if (projectConfig) {
    return projectConfig;
  }

  const globalConfigPath = path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
  const globalConfig = loadJsonFile(globalConfigPath);
  if (globalConfig) {
    return globalConfig;
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
      codebase_peek,
      index_codebase,
      index_status,
      index_health_check,
      index_metrics,
      index_logs,
      find_similar,
    },

    async config(cfg) {
      cfg.command = cfg.command ?? {};

      const commandsDir = getCommandsDir();
      const commands = loadCommandsFromDirectory(commandsDir);

      for (const [name, definition] of commands) {
        cfg.command[name] = definition;
      }
    },
  };
};

export default plugin;
