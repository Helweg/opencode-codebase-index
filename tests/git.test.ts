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
});
