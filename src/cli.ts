#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { handleEvalCommand } from "./eval/cli.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMergedConfig } from "./config/merger.js";
import { Indexer } from "./indexer/index.js";
import type { IndexProgress } from "./indexer/index.js";
import { formatIndexStats, formatProgressTitle } from "./tools/utils.js";
import { formatCostEstimate } from "./utils/cost.js";
import { initializeLogger } from "./utils/logger.js";
import { writeProgressLog } from "./utils/progress-log.js";
import { handleMigrateCommand } from "./migration/sqlite-to-pgvector.js";

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
  --verbose          Show detailed info about skipped files and parsing failures,
                     plus all internal log entries (info/debug) on the console
  -h, --help         Show this help message`);
    return;
  }

  const { project, force, estimateOnly, verbose } = parseIndexArgs(argv);
  const rawConfig = loadMergedConfig(project);
  const config = parseConfig(rawConfig);

  // Echo the resolved config so the user can confirm which settings the run
  // is actually using (project + global + defaults all merged).
  console.error(`Project root: ${project}`);
  console.error("Resolved config:");
  console.error(JSON.stringify(config, null, 2));
  console.error("");

  // Wire the global Logger to mirror entries to stderr. CLI runs are
  // interactive, so warn/error are surfaced by default and --verbose adds
  // info/debug. We force debug.enabled when verbose so shouldLog() gates
  // do not silence the very output the flag was meant to enable.
  if (verbose) {
    config.debug.enabled = true;
    config.debug.logLevel = "debug";
  }
  const logger = initializeLogger(config.debug);
  logger.setConsoleOutput(true, verbose ? "debug" : "warn");

  // Resolve progress log path against the project root for relative paths.
  const rawProgressLogFile = config.debug.progressLogFile;
  const progressLogFile = rawProgressLogFile
    ? path.isAbsolute(rawProgressLogFile)
      ? rawProgressLogFile
      : path.resolve(project, rawProgressLogFile)
    : undefined;
  if (progressLogFile) {
    console.error(`Progress log: ${progressLogFile}`);
    console.error("");
  }

  // De-duplicate identical progress snapshots so we don't spam stderr or the
  // log file with repeats from the embedding loop.
  let lastSnapshot = "";
  const onProgress = (progress: IndexProgress): void => {
    const snapshot = `${progress.phase}:${progress.filesProcessed}/${progress.totalFiles}:${progress.chunksProcessed}/${progress.totalChunks}:${progress.currentFiles?.join(",") ?? ""}`;
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;

    const message = formatProgressTitle(progress);
    console.error(message);
    if (progressLogFile) {
      writeProgressLog(progressLogFile, message);
    }
  };

  const indexer = new Indexer(project, config);
  await indexer.initialize();

  // Confirm which backend actually connected (helps diagnose SQLite-vs-pgvector confusion).
  if (config.database.engine === "pgvector" && config.database.pgvector) {
    const pg = config.database.pgvector;
    const connDesc = pg.connectionString
      ? "connection string"
      : `${pg.user ?? "postgres"}@${pg.host ?? "localhost"}:${pg.port ?? 5432}/${pg.database ?? "postgres"}`;
    console.error(`Database backend: pgvector (${connDesc})`);
  } else {
    const { resolveProjectIndexPath } = await import("./config/paths.js");
    const dbPath = path.join(resolveProjectIndexPath(project, config.scope), "codebase.db");
    console.error(`Database backend: sqlite (${dbPath})`);
  }
  console.error("");

  if (estimateOnly) {
    const estimate = await indexer.estimateCost();
    console.log(formatCostEstimate(estimate));
    return;
  }

  if (force) {
    console.error("Clearing existing index...");
    await indexer.clearIndex();
    const freshIndexer = new Indexer(project, config);
    await freshIndexer.initialize();
    console.error("Indexing...");
    const stats = await freshIndexer.index(onProgress);
    console.log(formatIndexStats(stats, verbose));
  } else {
    console.error("Indexing...");
    const stats = await indexer.index(onProgress);
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

  if (process.argv[2] === "migrate") {
    await handleMigrateCommand(process.argv.slice(3));
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
