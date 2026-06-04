import type { Plugin } from "@opencode-ai/plugin";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { loadMergedConfig } from "./config/merger.js";
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
  call_graph,
  implementation_lookup,
  add_knowledge_base,
  list_knowledge_bases,
  remove_knowledge_base,
  getSharedIndexer,
  initializeTools,
} from "./tools/index.js";
import { loadCommandsFromDirectory } from "./commands/loader.js";
import { RoutingHintController } from "./routing-hints.js";
import { hasProjectMarker } from "./utils/files.js";
import type { CombinedWatcher } from "./watcher/index.js";

let activeWatcher: CombinedWatcher | null = null;

function replaceActiveWatcher(nextWatcher: CombinedWatcher | null): void {
  activeWatcher?.stop();
  activeWatcher = nextWatcher;
}

function getCommandsDir(): string {
  let currentDir = process.cwd();
  
  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }
  
  return path.join(currentDir, "..", "commands");
}

const plugin: Plugin = async ({ directory }) => {
  try {
    const projectRoot = directory;
    const rawConfig = loadMergedConfig(projectRoot);
    const config = parseConfig(rawConfig);

    initializeTools(projectRoot, config);

    const indexer = getSharedIndexer();
    const routingHints = config.search.routingHints
      ? new RoutingHintController(() => indexer.getStatus())
      : null;

    const isValidProject = !config.indexing.requireProjectMarker || hasProjectMarker(projectRoot);

    if (!isValidProject) {
      console.warn(
        `[codebase-index] Skipping file watching and auto-indexing: no project marker found in "${projectRoot}". ` +
        `Set "indexing.requireProjectMarker": false in config to override.`
      );
    }

    if (config.indexing.autoIndex && isValidProject) {
      indexer.initialize().then(() => {
        indexer.index().catch(() => {});
      }).catch(() => {});
    }

    if (config.indexing.watchFiles && isValidProject) {
      replaceActiveWatcher(createWatcherWithIndexer(getSharedIndexer, projectRoot, config));
    } else {
      replaceActiveWatcher(null);
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
        call_graph,
        implementation_lookup,
        add_knowledge_base,
        list_knowledge_bases,
        remove_knowledge_base,
      },

      async "chat.message"(input, output) {
        routingHints?.observeUserMessage(input.sessionID, output.parts);
      },

      async "experimental.chat.system.transform"(input, output) {
        const hints = await routingHints?.getSystemHints(input.sessionID) ?? [];
        output.system.push(...hints);
      },

      async "tool.execute.after"(input) {
        routingHints?.markToolUsed(input.sessionID, input.tool);
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.error(`[codebase-index] Failed to initialize plugin: ${msg}`);
    // Return a plugin with no tools to prevent opencode from crashing
    return {
      tool: undefined,
      async config() {},
    };
  }
};

export default plugin;
