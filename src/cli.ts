#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { handleEvalCommand } from "./eval/cli.js";
import { Indexer } from "./indexer/index.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMergedConfig } from "./config/merger.js";
import { attachRecentActivity } from "./tools/visualize/activity.js";
import { generateVisualizationHtml, transformForVisualization } from "./tools/visualize/index.js";

interface VisualizeArgs {
  directory?: string;
  includeOrphans: boolean;
  maxNodes: number;
  project: string;
}

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

function parseVisualizeArgs(argv: string[], cwd: string): VisualizeArgs {
  let project = cwd;
  let directory: string | undefined;
  let includeOrphans = false;
  let maxNodes = 5000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (arg === "--max" && argv[i + 1]) {
      maxNodes = Number(argv[++i]);
    } else if (arg.startsWith("--max=") || arg.startsWith("max=")) {
      maxNodes = Number(arg.split("=")[1]);
    } else if (arg === "--orphans" || arg === "orphans" || arg === "--include-orphans" || arg === "include-orphans") {
      includeOrphans = true;
    } else if (!arg.startsWith("-") && directory === undefined) {
      directory = arg;
    }
  }

  if (!Number.isFinite(maxNodes) || maxNodes < 1) {
    throw new Error("max must be a positive number");
  }

  return { directory, includeOrphans, maxNodes, project };
}

async function handleVisualizeCommand(argv: string[], cwd: string): Promise<number> {
  try {
    const args = parseVisualizeArgs(argv, cwd);
    const config = parseConfig(loadMergedConfig(args.project));
    const indexer = new Indexer(args.project, config);
    const rawData = await indexer.getVisualizationData({
      directory: args.directory,
      maxNodes: args.maxNodes,
    });

    if (rawData.symbols.length === 0) {
      console.error("No call graph data found. Run /index in OpenCode first, then retry npm run visualize.");
      return 1;
    }

    const vizData = attachRecentActivity(transformForVisualization(rawData.symbols, rawData.edges, {
      includeOrphans: args.includeOrphans,
    }), args.project);

    if (vizData.nodes.length === 0) {
      console.error("No connected symbols found. Retry with: npm run visualize -- orphans");
      return 1;
    }

    const outputPath = path.join(os.tmpdir(), `call-graph-${Date.now()}.html`);
    writeFileSync(outputPath, generateVisualizationHtml(vizData), "utf-8");
    console.log(`Temporal call graph visualization generated: ${outputPath}`);
    console.log(`Nodes: ${vizData.nodes.length} | Edges: ${vizData.edges.length}`);
    console.log(`Recent change lenses: ${vizData.changes?.length ?? 0}`);
    if (rawData.truncated) {
      console.log(`Graph truncated to ${args.maxNodes} most-connected nodes.`);
    }
    return 0;
  } catch {
    console.error("Failed to generate visualization. Check the project, config, and arguments, then retry.");
    return 1;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const exitCode = await handleEvalCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
  }
  if (process.argv[2] === "visualize") {
    const exitCode = await handleVisualizeCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
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

main().catch((_error: unknown) => {
  console.error("Fatal: failed to start MCP server (check config and network)");
  process.exit(1);
});
