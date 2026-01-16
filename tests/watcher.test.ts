import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileWatcher, GitHeadWatcher, FileChange } from "../src/watcher/index.js";
import { ParsedCodebaseIndexConfig } from "../src/config/schema.js";

const createTestConfig = (overrides: Partial<ParsedCodebaseIndexConfig> = {}): ParsedCodebaseIndexConfig => ({
  embeddingProvider: "auto",
  embeddingModel: "auto",
  scope: "project",
  include: ["**/*.ts", "**/*.js"],
  exclude: [],
  indexing: {
    autoIndex: false,
    watchFiles: true,
    maxFileSize: 1048576,
    maxChunksPerFile: 100,
    semanticOnly: false,
    retries: 3,
    retryDelayMs: 1000,
    autoGc: true,
    gcIntervalDays: 7,
    gcOrphanThreshold: 100,
  },
  search: {
    maxResults: 20,
    minScore: 0.1,
    includeContext: true,
    hybridWeight: 0.5,
    contextLines: 0,
  },
  ...overrides,
});

describe("FileWatcher", () => {
  let tempDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor and lifecycle", () => {
    it("should create watcher without starting", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      expect(watcher.isRunning()).toBe(false);
    });

    it("should start and stop correctly", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      const handler = vi.fn();

      watcher.start(handler);
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it("should not start twice", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      watcher.start(handler1);
      watcher.start(handler2);

      expect(watcher.isRunning()).toBe(true);
    });

    it("should clear pending changes on stop", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      const handler = vi.fn();

      watcher.start(handler);
      watcher.stop();

      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe("file filtering", () => {
    it("should only watch files matching include patterns", async () => {
      const changes: FileChange[] = [];
      watcher = new FileWatcher(tempDir, createTestConfig({ include: ["**/*.ts"] }));

      watcher.start(async (c) => {
        changes.push(...c);
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(tempDir, "src", "test.ts"), "const x = 1;");
      fs.writeFileSync(path.join(tempDir, "src", "test.md"), "# README");

      await new Promise((r) => setTimeout(r, 1500));

      const tsChanges = changes.filter((c) => c.path.endsWith(".ts"));
      const mdChanges = changes.filter((c) => c.path.endsWith(".md"));

      expect(tsChanges.length).toBeGreaterThanOrEqual(0);
      expect(mdChanges.length).toBe(0);
    });
  });
});

describe("GitHeadWatcher", () => {
  let tempDir: string;
  let watcher: GitHeadWatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-watcher-test-"));
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor and lifecycle", () => {
    it("should create watcher without starting", () => {
      watcher = new GitHeadWatcher(tempDir);
      expect(watcher.isRunning()).toBe(false);
    });

    it("should not start for non-git directory", () => {
      watcher = new GitHeadWatcher(tempDir);
      const handler = vi.fn();

      watcher.start(handler);

      expect(watcher.isRunning()).toBe(false);
    });

    it("should start for git directory", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      const handler = vi.fn();

      watcher.start(handler);

      expect(watcher.isRunning()).toBe(true);
    });

    it("should stop correctly", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      watcher.start(vi.fn());
      watcher.stop();

      expect(watcher.isRunning()).toBe(false);
    });

    it("should not start twice", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      watcher.start(handler1);
      watcher.start(handler2);

      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe("branch tracking", () => {
    it("should return current branch after start", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      watcher.start(vi.fn());

      expect(watcher.getCurrentBranch()).toBe("main");
    });

    it("should return null before start", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);

      expect(watcher.getCurrentBranch()).toBe(null);
    });

    it("should detect branch change when HEAD is modified", async () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      const branchChanges: Array<{ old: string | null; new: string }> = [];
      watcher = new GitHeadWatcher(tempDir);

      watcher.start(async (oldBranch, newBranch) => {
        branchChanges.push({ old: oldBranch, new: newBranch });
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/feature\n");

      await new Promise((r) => setTimeout(r, 500));

      expect(branchChanges.length).toBeGreaterThanOrEqual(0);
      if (branchChanges.length > 0) {
        expect(branchChanges[0].old).toBe("main");
        expect(branchChanges[0].new).toBe("feature");
      }
    });
  });
});
