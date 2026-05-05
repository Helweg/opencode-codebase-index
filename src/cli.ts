#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { handleEvalCommand } from "./eval/cli.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMergedConfig } from "./config/merger.js";
import { Indexer } from "./indexer/index.js";
import { formatIndexStats } from "./tools/utils.js";
import { formatCostEstimate } from "./utils/cost.js";

function parseArgs(argv: string[]): { project: string; config?: string } {
  let project = process.cwd();
  let config: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config = path.resolve(argv[++i]);
    }
  }

  return { project, config };
}

function parseIndexArgs(argv: string[]): { project: string; force: boolean; estimateOnly: boolean; verbose: boolean } {
  let project = process.cwd();
  let force = false;
  let estimateOnly = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--force") {
      force = true;
    } else if (argv[i] === "--estimate-only") {
      estimateOnly = true;
    } else if (argv[i] === "--verbose") {
      verbose = true;
    }
  }

  return { project, force, estimateOnly, verbose };
}

async function handleIndexCommand(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(`Usage: opencode-codebase-index-mcp index [options]

Options:
  --project <path>   Project root directory (default: current directory)
  --force            Clear and rebuild the entire index from scratch
  --estimate-only    Show cost estimate without indexing
  --verbose          Show detailed info about skipped files and parsing failures
  -h, --help         Show this help message`);
    return;
  }

  const { project, force, estimateOnly, verbose } = parseIndexArgs(argv);
  const rawConfig = loadMergedConfig(project);
  const config = parseConfig(rawConfig);
  const indexer = new Indexer(project, config);

  await indexer.initialize();

  if (estimateOnly) {
    const estimate = await indexer.estimateCost();
    console.log(formatCostEstimate(estimate));
    return;
  }

  if (force) {
    console.log("Clearing existing index...");
    await indexer.clearIndex();
    const freshIndexer = new Indexer(project, config);
    await freshIndexer.initialize();
    console.log("Indexing...");
    const stats = await freshIndexer.index();
    console.log(formatIndexStats(stats, verbose));
  } else {
    console.log("Indexing...");
    const stats = await indexer.index();
    console.log(formatIndexStats(stats, verbose));
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const exitCode = await handleEvalCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
  }

  if (process.argv[2] === "index") {
    await handleIndexCommand(process.argv.slice(3));
    return;
  }

  const args = parseArgs(process.argv);
  const rawConfig = loadMergedConfig(args.project);
  const config = parseConfig(rawConfig);

  const server = createMcpServer(args.project, config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  const shutdown = (): void => {
    server.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
