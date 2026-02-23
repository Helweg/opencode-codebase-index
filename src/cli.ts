#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";

import { parseConfig } from "./config/schema.js";
import { createMcpServer } from "./mcp-server.js";

function loadJsonFile(filePath: string): unknown {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    }
  } catch { /* ignore */ }
  return null;
}

function loadPluginConfig(projectRoot: string, configPath?: string): unknown {
  if (configPath) {
    const config = loadJsonFile(configPath);
    if (config) return config;
  }

  const projectConfig = loadJsonFile(path.join(projectRoot, ".opencode", "codebase-index.json"));
  if (projectConfig) return projectConfig;

  const globalConfig = loadJsonFile(path.join(os.homedir(), ".config", "opencode", "codebase-index.json"));
  if (globalConfig) return globalConfig;

  return {};
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const rawConfig = loadPluginConfig(args.project, args.config);
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
