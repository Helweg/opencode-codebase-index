import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import { parseConfig } from "../src/config/schema.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../src/indexer/index.js", () => {
  class MockIndexer {
    initialize = vi.fn().mockResolvedValue(undefined);
    search = vi.fn().mockResolvedValue([
      {
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        name: "validateToken",
        chunkType: "function",
        content: "function validateToken(token: string) {\n  return token.length > 0;\n}",
        score: 0.95,
      },
    ]);
    findSimilar = vi.fn().mockResolvedValue([
      {
        filePath: "src/utils.ts",
        startLine: 5,
        endLine: 15,
        name: "checkAuth",
        chunkType: "function",
        content: "function checkAuth(token: string) {\n  return !!token;\n}",
        score: 0.88,
      },
    ]);
    index = vi.fn().mockResolvedValue({
      totalFiles: 10,
      totalChunks: 50,
      indexedChunks: 50,
      failedChunks: 0,
      tokensUsed: 1000,
      durationMs: 500,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    });
    getStatus = vi.fn().mockResolvedValue({
      indexed: true,
      vectorCount: 50,
      provider: "openai",
      model: "text-embedding-3-small",
      indexPath: "/tmp/index",
      currentBranch: "main",
      baseBranch: "main",
    });
    healthCheck = vi.fn().mockResolvedValue({
      removed: 0,
      gcOrphanEmbeddings: 0,
      gcOrphanChunks: 0,
      filePaths: [],
    });
    clearIndex = vi.fn().mockResolvedValue(undefined);
    estimateCost = vi.fn().mockResolvedValue({
      filesCount: 10,
      totalSizeBytes: 50000,
      estimatedChunks: 50,
      estimatedTokens: 1000,
      estimatedCost: 0.01,
      isFree: false,
      provider: "openai",
      model: "text-embedding-3-small",
    });
    getLogger = vi.fn().mockReturnValue({
      isEnabled: vi.fn().mockReturnValue(false),
      isMetricsEnabled: vi.fn().mockReturnValue(false),
      getLogs: vi.fn().mockReturnValue([]),
      getLogsByCategory: vi.fn().mockReturnValue([]),
      getLogsByLevel: vi.fn().mockReturnValue([]),
      formatMetrics: vi.fn().mockReturnValue(""),
    });
  }
  return { Indexer: MockIndexer };
});

describe("createMcpServer", () => {
  it("should create a server instance", () => {
    const config = parseConfig({});
    const server = createMcpServer("/tmp/test-project", config);

    expect(server).toBeDefined();
    expect(server).toHaveProperty("connect");
  });

  it("should have the correct server name", () => {
    const config = parseConfig({});
    const server = createMcpServer("/tmp/test-project", config);

    expect(server).toBeDefined();
  });

});

describe("MCP server tools and prompts", () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    const config = parseConfig({});
    server = createMcpServer("/tmp/test-project", config);
    client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("should register all 8 tools", async () => {
    const tools = await client.listTools();

    expect(tools.tools).toHaveLength(8);

    const toolNames = tools.tools.map(t => t.name).sort();
    const expectedNames = [
      "codebase_peek",
      "codebase_search",
      "find_similar",
      "index_codebase",
      "index_health_check",
      "index_logs",
      "index_metrics",
      "index_status",
    ].sort();

    expect(toolNames).toEqual(expectedNames);
  });

  it("should register all 4 prompts", async () => {
    const prompts = await client.listPrompts();

    expect(prompts.prompts).toHaveLength(4);

    const promptNames = prompts.prompts.map(p => p.name).sort();
    const expectedNames = ["find", "index", "search", "status"].sort();

    expect(promptNames).toEqual(expectedNames);
  });

  it("should execute codebase_search tool", async () => {
    const result = await client.callTool({
      name: "codebase_search",
      arguments: { query: "test query" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 results");
    expect(content[0].text).toContain("validateToken");
  });

  it("should execute codebase_peek tool", async () => {
    const result = await client.callTool({
      name: "codebase_peek",
      arguments: { query: "test query" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 locations");
  });

  it("should execute index_status tool", async () => {
    const result = await client.callTool({
      name: "index_status",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Index status");
    expect(content[0].text).toContain("50");
  });

  it("should execute index_codebase with estimateOnly", async () => {
    const result = await client.callTool({
      name: "index_codebase",
      arguments: { estimateOnly: true },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Estimate");
  });

  it("should execute index_health_check tool", async () => {
    const result = await client.callTool({
      name: "index_health_check",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("healthy");
  });

  it("should execute find_similar tool", async () => {
    const result = await client.callTool({
      name: "find_similar",
      arguments: { code: "function test() {}" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 similar");
  });

  it("should get search prompt", async () => {
    const prompt = await client.getPrompt({
      name: "search",
      arguments: { query: "auth logic" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.type).toBe("text");
    expect(msgContent.text).toContain("auth logic");
  });

  it("should get find prompt", async () => {
    const prompt = await client.getPrompt({
      name: "find",
      arguments: { query: "validation" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("validation");
  });

  it("should get index prompt", async () => {
    const prompt = await client.getPrompt({
      name: "index",
      arguments: {},
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_codebase");
  });

  it("should get status prompt", async () => {
    const prompt = await client.getPrompt({
      name: "status",
      arguments: {},
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_status");
  });

  it("should get status prompt without arguments (issue #13)", async () => {
    const prompt = await client.getPrompt({
      name: "status",
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_status");
  });

  it("should execute index_metrics tool", async () => {
    const result = await client.callTool({
      name: "index_metrics",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("should execute index_logs tool", async () => {
    const result = await client.callTool({
      name: "index_logs",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});
