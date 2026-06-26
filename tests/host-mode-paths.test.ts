import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMergedConfig } from "../src/config/merger.js";
import {
  resolveGlobalConfigPath,
  resolveGlobalIndexPath,
  resolveProjectConfigPath,
  resolveProjectIndexPath,
  resolveWritableProjectConfigPath,
} from "../src/config/paths.js";

describe("host-aware path resolution", () => {
  let tempDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let worktreeGitDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-mode-paths-"));
    mainRepoDir = path.join(tempDir, "main-repo");
    worktreeDir = path.join(tempDir, "worktree-feature");
    worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x"), { recursive: true });
    fs.mkdirSync(mainRepoDir, { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".git"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x", "y"), "2222222222222222222222222222222222222222\n");

    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature/x/y\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses host-specific writable config paths", () => {
    expect(resolveWritableProjectConfigPath(mainRepoDir, "opencode")).toBe(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
    );
    expect(resolveWritableProjectConfigPath(mainRepoDir, "codex")).toBe(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
    );
  });

  it("reads legacy OpenCode config for codex host when codex-native config is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "codex");
    const loaded = loadMergedConfig(mainRepoDir, "codex") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.knowledgeBases).toEqual(["legacy-docs"]);
  });

  it("prefers codex-native config for codex host when present", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index"), { recursive: true });

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
      JSON.stringify({ knowledgeBases: ["codex-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "codex");
    const loaded = loadMergedConfig(mainRepoDir, "codex") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".codebase-index", "config.json"));
    expect(loaded.knowledgeBases).toEqual(["codex-docs"]);
  });

  it("falls back to legacy global config for codex host when codex-native global config is absent", () => {
    const homeDir = os.homedir();
    fs.mkdirSync(path.join(homeDir, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".config", "opencode", "codebase-index.json"),
      JSON.stringify({ scope: "global", knowledgeBases: ["legacy-global-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveGlobalConfigPath("codex");
    const loaded = loadMergedConfig(mainRepoDir, "codex") as Record<string, unknown>;

    expect(resolved).toBe(path.join(homeDir, ".config", "opencode", "codebase-index.json"));
    expect(loaded.scope).toBe("global");
    expect(loaded.knowledgeBases).toEqual(["legacy-global-docs"]);
  });

  it("falls back to legacy worktree index when codex index is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(worktreeDir, "project", "codex")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });

  it("prefers codex-index inheritance before legacy when both exist", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(worktreeDir, "project", "codex")).toBe(
      path.join(mainRepoDir, ".codebase-index", "index"),
    );
  });

  it("falls back to legacy global index for codex host when codex-native global index is absent", () => {
    const homeDir = os.homedir();
    fs.mkdirSync(path.join(homeDir, ".opencode", "global-index"), { recursive: true });

    expect(resolveGlobalIndexPath("codex")).toBe(path.join(homeDir, ".opencode", "global-index"));
    expect(resolveProjectIndexPath(mainRepoDir, "global", "codex")).toBe(
      path.join(homeDir, ".opencode", "global-index"),
    );
  });

  it("keeps OpenCode project index path unchanged", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(mainRepoDir, "project", "opencode")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });
});
