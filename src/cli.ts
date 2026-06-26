#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as os from "os";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { parseHostMode, type HostMode } from "./config/host.js";
import { handleEvalCommand } from "./eval/cli.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMergedConfig } from "./config/merger.js";
import { getIndexerForProject } from "./tools/operations.js";
import { hasProjectMarker } from "./utils/files.js";
import { createWatcherWithIndexer, type CombinedWatcher } from "./watcher/index.js";

function parseArgs(argv: string[]): { project: string; config?: string; host: HostMode } {
  let project = process.cwd();
  let config: string | undefined;
  let host: HostMode = "opencode";

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config = path.resolve(argv[++i]);
    } else if (argv[i] === "--host" && argv[i + 1]) {
      host = parseHostMode(argv[++i]);
    } else if (argv[i] === "--host") {
      host = parseHostMode(undefined);
    }
  }

  return { project, config, host };
}

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const exitCode = await handleEvalCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
  }

  const args = parseArgs(process.argv);
  const rawConfig = loadMergedConfig(args.project, args.host);
  const config = parseConfig(rawConfig);

  const server = createMcpServer(args.project, config, args.host);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  let watcher: CombinedWatcher | null = null;
  const isHomeDir = path.resolve(args.project) === path.resolve(os.homedir());
  const isValidProject = !isHomeDir && (!config.indexing.requireProjectMarker || hasProjectMarker(args.project));

  if (config.indexing.autoIndex && isValidProject) {
    const indexer = getIndexerForProject(args.project, args.host);
    indexer.initialize().then(() => {
      indexer.index().catch(() => {});
    }).catch(() => {});
  }

  if (config.indexing.watchFiles && isValidProject) {
    watcher = createWatcherWithIndexer(
      () => getIndexerForProject(args.project, args.host),
      args.project,
      config,
    );
  }

  const shutdown = (): void => {
    watcher?.stop();
    server.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.message.startsWith("Invalid host mode")) {
    console.error(error.message);
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(error.message);
    process.exit(1);
  }

  console.error("Fatal: failed to start MCP server");
  process.exit(1);
});
