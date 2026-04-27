import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMergedConfig } from "../src/config/merger.js";
import { parseConfig } from "../src/config/schema.js";
import { resolveProjectConfigPath, resolveProjectIndexPath, resolveWritableProjectConfigPath } from "../src/config/paths.js";
import { Indexer } from "../src/indexer/index.js";

describe("worktree fallback (issue #60)", () => {
  let tempDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let worktreeGitDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-"));
    mainRepoDir = path.join(tempDir, "main-repo");
    worktreeDir = path.join(tempDir, "worktree-feature");
    worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x", "y"), "2222222222222222222222222222222222222222\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature/x/y\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          scope: "project",
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: ["docs/reference"],
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads project config from the main repo when the worktree has no local config", () => {
    const configPath = resolveProjectConfigPath(worktreeDir);
    const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

    expect(configPath).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.scope).toBe("project");
    expect(loaded.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("rebases inherited absolute repo-local knowledge bases onto the worktree", () => {
    const absoluteRepoLocalKb = path.join(mainRepoDir, "docs", "reference");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          scope: "project",
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: [absoluteRepoLocalKb],
        },
        null,
        2
      ),
      "utf-8"
    );

    const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

    expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("resolves the project index path to the main repo when the worktree has no local index", async () => {
    const config = parseConfig(loadMergedConfig(worktreeDir));
    const indexer = new Indexer(worktreeDir, config);
    const status = await indexer.getStatus();

    expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(path.join(mainRepoDir, ".opencode", "index"));
    expect(status.indexPath).toBe(path.join(mainRepoDir, ".opencode", "index"));
    expect(status.currentBranch).toBe("feature/x/y");
  });

  it("keeps explicit worktree-local config and index when they exist", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ scope: "project", knowledgeBases: ["worktree-only"] }, null, 2),
      "utf-8"
    );

    const configPath = resolveProjectConfigPath(worktreeDir);
    const indexPath = resolveProjectIndexPath(worktreeDir, "project");
    const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

    expect(configPath).toBe(path.join(worktreeDir, ".opencode", "codebase-index.json"));
    expect(indexPath).toBe(path.join(worktreeDir, ".opencode", "index"));
    expect(loaded.knowledgeBases).toEqual(["worktree-only"]);
  });

  it("keeps a worktree-local config on a local worktree index boundary", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });

    expect(resolveWritableProjectConfigPath(worktreeDir)).toBe(path.join(worktreeDir, ".opencode", "codebase-index.json"));
    expect(resolveProjectConfigPath(worktreeDir)).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(path.join(worktreeDir, ".opencode", "index"));
  });

  it("keeps explicit worktree-local config and index when they exist", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });

    fs.writeFileSync(
      path.join(worktreeDir, ".opencode", "codebase-index.json"),
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "worktree-model",
          dimensions: 16,
        },
        scope: "project",
      }, null, 2),
      "utf-8"
    );

    expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(path.join(worktreeDir, ".opencode", "index"));
  });
});
