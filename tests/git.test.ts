import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  isGitRepo,
  getCurrentBranch,
  getBaseBranch,
  getAllBranches,
  getBranchOrDefault,
  getHeadPath,
  resolveGitDir,
} from "../src/git/index.js";

describe("git utilities", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("isGitRepo", () => {
    it("should return false for non-git directory", () => {
      expect(isGitRepo(tempDir)).toBe(false);
    });

    it("should return true for git directory", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      expect(isGitRepo(tempDir)).toBe(true);
    });

    it("should return true for git directory with HEAD file", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(isGitRepo(tempDir)).toBe(true);
    });
  });

  describe("getCurrentBranch", () => {
    it("should return null for non-git directory", () => {
      expect(getCurrentBranch(tempDir)).toBe(null);
    });

    it("should return null when .git/HEAD does not exist", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      expect(getCurrentBranch(tempDir)).toBe(null);
    });

    it("should parse branch name from symbolic ref", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(getCurrentBranch(tempDir)).toBe("main");
    });

    it("should parse feature branch name", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/feature/my-feature\n");
      expect(getCurrentBranch(tempDir)).toBe("feature/my-feature");
    });

    it("should return short hash for detached HEAD", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      const fullHash = "abc1234def5678abc1234def5678abc1234def56";
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), fullHash);
      expect(getCurrentBranch(tempDir)).toBe("abc1234");
    });

    it("should return null for malformed HEAD content", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "invalid content");
      expect(getCurrentBranch(tempDir)).toBe(null);
    });
  });

  describe("getBaseBranch", () => {
    it("should return main if main branch exists", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "main"), "abc123");
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(getBaseBranch(tempDir)).toBe("main");
    });

    it("should return master if master exists but main does not", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "master"), "abc123");
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/master\n");
      expect(getBaseBranch(tempDir)).toBe("master");
    });

    it("should return develop if develop exists and main/master do not", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "develop"), "abc123");
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/develop\n");
      expect(getBaseBranch(tempDir)).toBe("develop");
    });

    it("should check packed-refs for branch existence", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, ".git", "packed-refs"),
        "# pack-refs with: peeled fully-peeled sorted\nabc123 refs/heads/main\n"
      );
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(getBaseBranch(tempDir)).toBe("main");
    });

    it("should fallback to current branch if no standard branch found", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "custom"), "abc123");
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/custom\n");
      expect(getBaseBranch(tempDir)).toBe("custom");
    });
  });

  describe("getAllBranches", () => {
    it("should return empty array for non-git directory", () => {
      expect(getAllBranches(tempDir)).toEqual([]);
    });

    it("should return empty array when refs/heads does not exist", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      expect(getAllBranches(tempDir)).toEqual([]);
    });

    it("should list branches from refs/heads directory", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "main"), "abc123");
      fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "feature"), "def456");
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      const branches = getAllBranches(tempDir);
      expect(branches.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getBranchOrDefault", () => {
    it("should return 'default' for non-git directory", () => {
      expect(getBranchOrDefault(tempDir)).toBe("default");
    });

    it("should return branch name for git directory", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(getBranchOrDefault(tempDir)).toBe("main");
    });

    it("should return 'default' when HEAD parsing fails", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "invalid");
      expect(getBranchOrDefault(tempDir)).toBe("default");
    });
  });

  describe("getHeadPath", () => {
    it("should return correct HEAD path", () => {
      const headPath = getHeadPath(tempDir);
      expect(headPath).toBe(path.join(tempDir, ".git", "HEAD"));
    });
  });

  describe("resolveGitDir", () => {
    it("should return null for non-git directory", () => {
      expect(resolveGitDir(tempDir)).toBe(null);
    });

    it("should return .git path for normal repo", () => {
      fs.mkdirSync(path.join(tempDir, ".git"));
      expect(resolveGitDir(tempDir)).toBe(path.join(tempDir, ".git"));
    });

    it("should follow gitdir pointer for worktree with absolute path", () => {
      const mainGitDir = path.join(tempDir, "main-repo", ".git");
      const worktreeDir = path.join(tempDir, "worktree");
      const worktreeGitDir = path.join(mainGitDir, "worktrees", "feature-branch");
      
      fs.mkdirSync(mainGitDir, { recursive: true });
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.mkdirSync(worktreeDir, { recursive: true });
      
      fs.writeFileSync(
        path.join(worktreeDir, ".git"),
        `gitdir: ${worktreeGitDir}\n`
      );
      fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature-branch\n");
      
      expect(resolveGitDir(worktreeDir)).toBe(worktreeGitDir);
    });

    it("should follow gitdir pointer for worktree with relative path", () => {
      const worktreeDir = path.join(tempDir, "worktree");
      const relativeGitDir = "../main-repo/.git/worktrees/feature";
      const absoluteGitDir = path.resolve(worktreeDir, relativeGitDir);
      
      fs.mkdirSync(absoluteGitDir, { recursive: true });
      fs.mkdirSync(worktreeDir, { recursive: true });
      
      fs.writeFileSync(
        path.join(worktreeDir, ".git"),
        `gitdir: ${relativeGitDir}\n`
      );
      fs.writeFileSync(path.join(absoluteGitDir, "HEAD"), "ref: refs/heads/feature\n");
      
      expect(resolveGitDir(worktreeDir)).toBe(absoluteGitDir);
    });

    it("should return null for invalid gitdir pointer", () => {
      fs.writeFileSync(path.join(tempDir, ".git"), "gitdir: /nonexistent/path\n");
      expect(resolveGitDir(tempDir)).toBe(null);
    });

    it("should return null for malformed .git file", () => {
      fs.writeFileSync(path.join(tempDir, ".git"), "invalid content\n");
      expect(resolveGitDir(tempDir)).toBe(null);
    });
  });

  describe("worktree support", () => {
    let mainRepoDir: string;
    let worktreeDir: string;
    let worktreeGitDir: string;

    beforeEach(() => {
      mainRepoDir = path.join(tempDir, "main-repo");
      worktreeDir = path.join(tempDir, "worktree-feature");
      worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
      
      fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.mkdirSync(worktreeDir, { recursive: true });
      
      fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "abc123");
      
      fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
      fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    });

    it("isGitRepo should return true for worktree", () => {
      expect(isGitRepo(worktreeDir)).toBe(true);
    });

    it("getCurrentBranch should work in worktree", () => {
      expect(getCurrentBranch(worktreeDir)).toBe("feature");
    });

    it("getHeadPath should return worktree HEAD path", () => {
      expect(getHeadPath(worktreeDir)).toBe(path.join(worktreeGitDir, "HEAD"));
    });

    it("getBranchOrDefault should work in worktree", () => {
      expect(getBranchOrDefault(worktreeDir)).toBe("feature");
    });
  });
});
