import type { Plugin } from "@opencode-ai/plugin";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { loadMergedConfig } from "./config/merger.js";
import { createWatcherWithIndexer } from "./watcher/index.js";
import { initializeLogger } from "./utils/logger.js";
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
  refreshIndexerFromConfig,
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

const plugin: Plugin = async ({ directory, client }) => {
  try {
    const projectRoot = directory;
    const rawConfig = loadMergedConfig(projectRoot);
    const config = parseConfig(rawConfig);

    // Initialize logger for file-based logging
    const logger = initializeLogger(config.debug);

    // Forward error/warn log entries to the client system log so they are
    // always visible regardless of debug.enabled or log level settings.
    logger.setClientLogger((level, message, extra) => {
      client.app.log({
        body: { service: "codebase-index", level, message, extra },
      }).catch(() => { /* best-effort; never throw from logger callback */ });
    });

    // Log final merged configuration if debug is enabled
    if (config.debug.enabled) {
      await client.app.log({
        body: {
          service: "codebase-index",
          level: "info",
          message: "Final merged configuration",
          extra: {
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        scope: config.scope,
        database: {
          engine: config.database.engine,
          pgvectorHost: config.database.engine === "pgvector" && config.database.pgvector?.host
            ? `${config.database.pgvector.host}:${config.database.pgvector.port || 5432}`
            : undefined,
          pgvectorDatabase: config.database.engine === "pgvector" ? config.database.pgvector?.database : undefined,
          pgvectorTablePrefix: config.database.engine === "pgvector" ? config.database.pgvector?.tablePrefix : undefined,
        },
        indexing: {
          autoIndex: config.indexing.autoIndex,
          skipAutoIndexOnLoad: config.indexing.skipAutoIndexOnLoad,
          watchFiles: config.indexing.watchFiles,
          requireProjectMarker: config.indexing.requireProjectMarker,
          semanticOnly: config.indexing.semanticOnly,
          maxFileSize: config.indexing.maxFileSize,
          maxChunksPerFile: config.indexing.maxChunksPerFile,
        },
        search: {
          hybridWeight: config.search.hybridWeight,
          fusionStrategy: config.search.fusionStrategy,
          rerankTopN: config.search.rerankTopN,
          routingHints: config.search.routingHints,
        },
        reranker: {
          enabled: config.reranker?.enabled ?? false,
          provider: config.reranker?.provider,
        },
          }
        }
      });

      // Log database connection info
      if (config.database.engine === "pgvector" && config.database.pgvector) {
        const pgConfig = config.database.pgvector;
        const connectionInfo = pgConfig.connectionString
          ? "(via connection string)"
          : `${pgConfig.user}@${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`;
        await client.app.log({
          body: {
            service: "codebase-index",
            level: "info",
            message: `Connecting to pgvector database: ${connectionInfo}`,
          }
        });
        if (pgConfig.tablePrefix) {
          await client.app.log({
            body: {
              service: "codebase-index",
              level: "info",
              message: `Using table prefix: "${pgConfig.tablePrefix}"`,
            }
          });
        }
      } else {
        await client.app.log({
          body: {
            service: "codebase-index",
            level: "info",
            message: `Using local SQLite database at: ${projectRoot}/.opencode/index/`,
          }
        });
      }
    }

    initializeTools(projectRoot, config);

    const indexer = getSharedIndexer();
    const routingHints = config.search.routingHints
      ? new RoutingHintController(() => indexer.getStatus())
      : null;

    const isValidProject = !config.indexing.requireProjectMarker || hasProjectMarker(projectRoot);

    if (!isValidProject) {
      logger.warn(
        `Skipping file watching and auto-indexing: no project marker found in "${projectRoot}". ` +
        `Set "indexing.requireProjectMarker": false in config to override.`
      );
      await client.app.log({
        body: {
          service: "codebase-index",
          level: "warn",
          message: `Skipping file watching and auto-indexing: no project marker found in "${projectRoot}". Set "indexing.requireProjectMarker": false in config to override.`,
        }
      });
    }

    if (config.indexing.autoIndex && !config.indexing.skipAutoIndexOnLoad && isValidProject) {
      // Defer to after the plugin function returns so the client is fully started
      // before we begin connecting to the database and indexing.
      // Also reload config at fire-time so the indexer always uses the latest
      // merged config (e.g., pgvector credentials that may not have been fully
      // resolved at plugin-load time).
      setImmediate(() => {
        refreshIndexerFromConfig();
        const bgIndexer = getSharedIndexer();
        bgIndexer.initialize().then(() => {
          bgIndexer.index().catch(() => {});
        }).catch(() => {});
      });
    } else if (config.indexing.autoIndex && config.indexing.skipAutoIndexOnLoad && config.debug.enabled) {
      await client.app.log({
        body: {
          service: "codebase-index",
          level: "debug",
          message: "Skipping auto-index on load (skipAutoIndexOnLoad is true)",
        }
      });
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
    await client.app.log({
      body: {
        service: "codebase-index",
        level: "error",
        message: "Failed to initialize plugin",
        extra: {
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }).catch(() => {});
    // Return a plugin with no tools to prevent opencode from crashing
    return {
      tool: undefined,
      async config() {},
    };
  }
};

export default plugin;
