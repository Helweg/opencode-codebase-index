import * as fs from "fs";

import { describe, expect, it } from "vitest";
import { parseHostMode } from "../src/config/host.js";

describe("Codex plugin host mode", () => {
  it("parses known host modes", () => {
    expect(parseHostMode("opencode")).toBe("opencode");
    expect(parseHostMode("codex")).toBe("codex");
    expect(parseHostMode("claude")).toBe("claude");
    expect(parseHostMode("pi")).toBe("pi");
  });

  it("rejects unknown host mode with a clear error", () => {
    expect(() => parseHostMode("weird"))
      .toThrow("Invalid host mode: weird. Allowed values: opencode, codex, claude, pi.");
  });

  it("exposes Codex plugin manifest and MCP command", () => {
    const pluginManifest = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf-8")) as {
      mcpServers?: string;
      hooks?: string;
      version: string;
      name: string;
    };
    const mcpManifest = JSON.parse(fs.readFileSync(".mcp.json", "utf-8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(pluginManifest.name).toBe("codebase-index");
    expect(pluginManifest.version).toBe("0.12.0");
    expect(pluginManifest.mcpServers).toBe("./.mcp.json");
    expect(pluginManifest.hooks).toBe("./hooks/hooks.json");
    expect(fs.existsSync("hooks/hooks.json")).toBe(true);

    const codebaseMcp = mcpManifest.mcpServers["codebase-index"];
    expect(codebaseMcp.command).toBe("node");
    expect(codebaseMcp.args).toContain("--host");
    expect(codebaseMcp.args).toContain("codex");
  });
});
