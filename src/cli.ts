#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";

import { parseConfig } from "./config/schema.js";
import { handleEvalCommand } from "./eval/cli.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMergedConfig } from "./config/merger.js";

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

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const exitCode = await handleEvalCommand(process.argv.slice(3), process.cwd());
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
