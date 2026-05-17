#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { handleEvalCommand } from "./eval/cli.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMergedConfig } from "./config/merger.js";

function parseArgs(argv: string[]): { help: boolean; mcp: boolean; project: string; config?: string } {
  let help = false;
  let mcp = false;
  let project = process.cwd();
  let config: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      help = true;
    } else if (argv[i] === "--mcp") {
      mcp = true;
    } else if (argv[i] === "--project" && argv[i + 1]) {
      project = path.resolve(argv[++i]);
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config = path.resolve(argv[++i]);
    }
  }

  return { help, mcp, project, config };
}

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const exitCode = await handleEvalCommand(process.argv.slice(3), process.cwd());
    process.exit(exitCode);
  }

  const args = parseArgs(process.argv);

  // Show help and exit early (before trying to load native module)
  if (args.help) {
    console.log(`Usage:
  npx opencode-codebase-index --mcp --project PATH    Start MCP server
  npx opencode-codebase-index --help                   Show this help
  npx opencode-codebase-index eval ...                 Run evaluation

Aliases:
  npx opencode-codebase-index-mcp  (equivalent to --mcp)
`);
    process.exit(0);
  }

  // --mcp flag required when using opencode-codebase-index bin
  // (opencode-codebase-index-mcp bin defaults to MCP mode for backwards compatibility)
  const isMcpBin = process.argv[0]?.endsWith("codebase-index-mcp") || process.execPath.includes("codebase-index-mcp");
  const shouldRunMcp = args.mcp || isMcpBin;

  if (!shouldRunMcp) {
    console.error("Usage: npx opencode-codebase-index --mcp --project PATH");
    console.error("       npx opencode-codebase-index eval ...");
    console.error("\nNote: Use '--mcp' flag to start the MCP server.");
    console.error("Or use 'npx opencode-codebase-index-mcp' for backwards compatibility.");
    process.exit(1);
  }

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
