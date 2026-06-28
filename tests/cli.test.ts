import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCliRawConfig, parseArgs } from "../src/cli.js";

describe("cli config loading", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "cli-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads explicit --config file instead of merged host config", () => {
    const configPath = path.join(tempDir, "custom-config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ embeddingProvider: "ollama", include: ["custom/**/*.ts"] }, null, 2),
      "utf-8",
    );

    const args = parseArgs(["node", "dist/cli.js", "--project", tempDir, "--host", "codex", "--config", configPath]);
    const rawConfig = loadCliRawConfig(args) as Record<string, unknown>;

    expect(rawConfig.embeddingProvider).toBe("ollama");
    expect(rawConfig.include).toEqual(["custom/**/*.ts"]);
  });
});
