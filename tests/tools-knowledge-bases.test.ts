import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { indexerInstances, MockIndexer } = vi.hoisted(() => {
  const indexerInstances: Array<{ projectRoot: string; config: Record<string, unknown> }> = [];

  class MockIndexer {
    public readonly projectRoot: string;
    public readonly config: Record<string, unknown>;

    public constructor(projectRoot: string, config: Record<string, unknown>) {
      this.projectRoot = projectRoot;
      this.config = config;
      indexerInstances.push({ projectRoot, config });
    }

    public estimateCost = vi.fn().mockResolvedValue({
      filesCount: 0,
      totalSizeBytes: 0,
      estimatedChunks: 0,
      estimatedTokens: 0,
      estimatedCost: 0,
      isFree: true,
      provider: "ollama",
      model: "nomic-embed-text",
    });

    public clearIndex = vi.fn().mockResolvedValue(undefined);
    public index = vi.fn().mockResolvedValue({
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    });

    public getStatus = vi.fn().mockResolvedValue({
      indexed: true,
      vectorCount: 0,
      provider: "ollama",
      model: "nomic-embed-text",
      indexPath: "/tmp/index",
      currentBranch: "main",
      baseBranch: "main",
    });

    public healthCheck = vi.fn().mockResolvedValue({
      removed: 0,
      gcOrphanEmbeddings: 0,
      gcOrphanChunks: 0,
      gcOrphanSymbols: 0,
      gcOrphanCallEdges: 0,
      filePaths: [],
    });

    public getLogger = vi.fn().mockReturnValue({
      isEnabled: vi.fn().mockReturnValue(false),
      isMetricsEnabled: vi.fn().mockReturnValue(false),
      getLogs: vi.fn().mockReturnValue([]),
      getLogsByCategory: vi.fn().mockReturnValue([]),
      getLogsByLevel: vi.fn().mockReturnValue([]),
      formatMetrics: vi.fn().mockReturnValue(""),
    });
  }

  return { indexerInstances, MockIndexer };
});

vi.mock("../src/indexer/index.js", () => ({
  Indexer: MockIndexer,
}));

import { parseConfig } from "../src/config/schema.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { add_knowledge_base, initializeTools, remove_knowledge_base } from "../src/tools/index.js";

describe("knowledge base tool config refresh", () => {
  let tempDir: string;
  let kbDir: string;

  beforeEach(() => {
    indexerInstances.length = 0;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tools-test-"));
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-source-"));
    initializeTools(tempDir, parseConfig({ indexing: { watchFiles: false } }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
  });

  it("rebuilds the shared indexer after adding a knowledge base", async () => {
    await add_knowledge_base.execute({ path: kbDir });

    expect(indexerInstances).toHaveLength(2);
    expect(indexerInstances[1]?.projectRoot).toBe(tempDir);
    expect(indexerInstances[1]?.config.knowledgeBases).toEqual([path.normalize(kbDir)]);
  });

  it("rebuilds the shared indexer after removing a knowledge base", async () => {
    await add_knowledge_base.execute({ path: kbDir });
    await remove_knowledge_base.execute({ path: kbDir });

    expect(indexerInstances).toHaveLength(3);
    expect(indexerInstances[2]?.projectRoot).toBe(tempDir);
    expect(indexerInstances[2]?.config.knowledgeBases).toEqual([]);
  });

  it("writes inherited worktree config updates back to the resolved source config", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(
      mainConfigPath,
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
        knowledgeBases: [],
      }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    await add_knowledge_base.execute({ path: kbDir });

    const savedMainConfig = JSON.parse(fs.readFileSync(mainConfigPath, "utf-8")) as { knowledgeBases?: string[] };
    expect(savedMainConfig.knowledgeBases).toEqual([path.normalize(kbDir)]);
    expect(fs.existsSync(path.join(worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
    expect(indexerInstances.at(-1)?.projectRoot).toBe(worktreeDir);
    expect(indexerInstances.at(-1)?.config.knowledgeBases).toEqual([path.normalize(kbDir)]);
  });
});
